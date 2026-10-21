//! A bot's actors, one per place it talks (see `agent::bot`): started by the first command for a
//! place, addressed by the place a command concerns, and seen by clients as one bot.

use super::{BotStatus, Hub, Runtime};
use crate::LockExt;
use crate::agent::bot::{self, BotHandle, Cmd, actor_key, bot_of, place_of};
use crate::chat::memory;
use crate::store::{BotConfig, Lane, lane_key};
use anyhow::{Result, anyhow};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// A bot's actors and the dreamer they share.
pub struct BotActors {
    dreamer: mpsc::UnboundedSender<memory::DreamEvent>,
    /// Actor key -> the place it serves, and its handle.
    places: HashMap<String, (Lane, BotHandle)>,
}

impl Hub {
    /// Starts the bot's own chat, and any place where the previous host process cut off a turn so it resumes.
    pub(super) fn spawn_bot(self: &Arc<Self>, cfg: &BotConfig) {
        let id = cfg.id.clone();
        // An hq agent keeps its own memory (in its folder): Kith's keeper never runs for it. Its sends go nowhere.
        let dreamer =
            if cfg.is_hq() { mpsc::unbounded_channel().0 } else { memory::spawn_dreamer(self.clone(), id.clone()) };
        let mut places = HashMap::new();
        let mut homes = vec![Lane::main(&id)];
        homes.extend(bot::interrupted_places(&self.store, &id));
        for home in homes {
            let key = actor_key(&id, &home);
            self.runtime.locked().insert(key.clone(), Runtime::default());
            let handle = bot::spawn(self.clone(), cfg.clone(), home.clone(), dreamer.clone());
            places.insert(key, (home, handle));
        }
        self.bots.locked().insert(id, BotActors { dreamer, places });
    }

    /// Stops every actor (and so every agent process), waiting briefly for them to exit.
    pub async fn shutdown(&self) {
        self.routines.stop().await;
        let handles: Vec<BotHandle> =
            self.bots.locked().drain().flat_map(|(_, a)| a.places.into_values().map(|(_, h)| h)).collect();
        let tasks: Vec<_> = handles
            .into_iter()
            .map(|h| {
                let _ = h.tx.send(Cmd::Shutdown);
                h.task
            })
            .collect();
        if tokio::time::timeout(Duration::from_secs(5), futures::future::join_all(tasks)).await.is_err() {
            tracing::warn!("some bots didn't stop within 5 s");
        }
        self.keep_awake.locked().set(false);
    }

    /// Memory is short: stops the agent that has sat unused the longest, among those at rest and able to load
    /// their sessions again. Whether one stopped.
    pub async fn reclaim_idle_agent(&self) -> bool {
        const REPLY: Duration = Duration::from_secs(2);
        let txs: Vec<mpsc::UnboundedSender<Cmd>> =
            self.bots.locked().values().flat_map(|a| a.places.values().map(|(_, h)| h.tx.clone())).collect();
        let asked = txs.into_iter().map(|tx| async move {
            let (reply, idle) = oneshot::channel();
            tx.send(Cmd::IdleFor(reply)).ok()?;
            let idle = tokio::time::timeout(REPLY, idle).await.ok()?.ok()??;
            Some((idle, tx))
        });
        let mut candidates: Vec<_> = futures::future::join_all(asked).await.into_iter().flatten().collect();
        candidates.sort_by_key(|(idle, _)| std::cmp::Reverse(*idle));
        for (_, tx) in candidates {
            let (reply, stopped) = oneshot::channel();
            if tx.send(Cmd::StopIdle(reply)).is_ok()
                && matches!(tokio::time::timeout(REPLY, stopped).await, Ok(Ok(true)))
            {
                return true;
            }
        }
        false
    }

    /// Stops all of a deleted bot's actors and forgets their state; for a group, its members' actors in it.
    pub(super) fn remove_bot_actors(&self, id: &str) {
        // Shut down only: a bot without actors (a group) has nothing to stop.
        let _ = self.send_cmd(id, Cmd::Shutdown);
        self.bots.locked().remove(id);
        self.runtime.locked().retain(|key, _| bot_of(key) != id);
        self.close_group_places(id, &[]);
    }

    /// Stops the actors that bots other than `members` have in the group `group` (it was deleted, or they left it).
    pub(super) fn close_group_places(&self, group: &str, members: &[String]) {
        let closed: Vec<(String, BotHandle)> = {
            let mut bots = self.bots.locked();
            let leaving = bots.iter_mut().filter(|(bot, _)| !members.contains(bot));
            leaving
                .flat_map(|(_, actors)| {
                    let keys: Vec<String> = actors
                        .places
                        .iter()
                        .filter(|(_, (home, _))| home.chat == group)
                        .map(|(k, _)| k.clone())
                        .collect();
                    keys.into_iter().filter_map(|k| actors.places.remove(&k).map(|(_, h)| (k, h))).collect::<Vec<_>>()
                })
                .collect()
        };
        let mut touched: Vec<String> = closed.iter().map(|(key, _)| bot_of(key).to_owned()).collect();
        {
            let mut runtime = self.runtime.locked();
            for (key, handle) in closed {
                // An actor that already stopped needs nothing more.
                let _ = handle.tx.send(Cmd::Shutdown);
                runtime.remove(&key);
            }
        }
        touched.dedup();
        for bot in touched {
            self.emit_bot(&bot);
        }
    }

    /// A command for a bot, delivered to the actor of the place it concerns: a message or a room turn to that
    /// place (started if it isn't running yet), a card's answer to the actor whose turn shows it, a group's stop to
    /// the bot's actors in that group. Stop, tool and settings changes and shutdown reach all of its actors; the
    /// rest (routines, other bots' requests, a new session) go to its own chat.
    pub fn send_cmd(&self, bot_id: &str, cmd: Cmd) -> Result<()> {
        match cmd {
            // To the actor already talking there (a routine run in a thread), so one session never runs twice.
            Cmd::Send { ref lane, .. } => {
                let key = self.actor_in(bot_id, lane);
                self.send_to_actor(&key, cmd)
            }
            Cmd::Group(ref turn) => {
                let key = self.actor_in(bot_id, &turn.lane);
                self.send_to_actor(&key, cmd)
            }
            Cmd::Permission { ref entry_id, .. } | Cmd::Routed { ref entry_id, .. } => {
                let lane = self.store.entry(entry_id).map(|e| Lane { chat: e.bot_id, thread: e.thread_id });
                let key = lane.map_or_else(|| bot_id.to_owned(), |l| self.actor_in(bot_id, &l));
                // A card in a place with no actor has no turn waiting on it; the bot's own chat drops the answer.
                let key = if self.has_place(bot_id, &place_of(&key)) { key } else { bot_id.to_owned() };
                self.send_to_actor(&key, cmd)
            }
            Cmd::CancelGroup { chat } => {
                self.each_actor(bot_id, |home| home.chat == chat, || Cmd::CancelGroup { chat: chat.clone() })
            }
            Cmd::Stop => self.each_actor(bot_id, |_| true, || Cmd::Stop),
            Cmd::RefreshTools => self.each_actor(bot_id, |_| true, || Cmd::RefreshTools),
            Cmd::Shutdown => self.each_actor(bot_id, |_| true, || Cmd::Shutdown),
            Cmd::Reconfigure(cfg) => self.each_actor(bot_id, |_| true, || Cmd::Reconfigure(cfg.clone())),
            // A new session starts the bot afresh in its groups too; its threads keep theirs.
            Cmd::NewSession => {
                self.forget_group_sessions(bot_id);
                self.each_actor(bot_id, |home| home.chat != bot_id, || Cmd::NewSession)?;
                self.deliver(bot_id, &Lane::main(bot_id), Cmd::NewSession)
            }
            cmd => self.deliver(bot_id, &Lane::main(bot_id), cmd),
        }
    }

    /// Drops the stored sessions of the bot's group places (`lane_key("session", bot, group lane)`), so one without
    /// a running actor starts afresh too.
    fn forget_group_sessions(&self, bot_id: &str) {
        let threads = lane_key("session", bot_id, &Lane::main(bot_id)) + "/";
        for key in self.store.kv_prefix(&format!("lane.session.{bot_id}@")) {
            if !key.starts_with(&threads)
                && let Err(error) = self.store.kv_delete(&key)
            {
                tracing::warn!(bot = bot_id, error = format!("{error:#}"), "couldn't forget a group session");
            }
        }
    }

    /// A command for one actor (by its key, see [`actor_key`]), started if it isn't running.
    pub fn send_to_actor(&self, key: &str, cmd: Cmd) -> Result<()> {
        self.deliver(bot_of(key), &place_of(key), cmd)
    }

    /// Stop in one place: the actor there, and an actor whose turn talks there (a routine run in its thread).
    pub fn stop_place(&self, bot_id: &str, lane: &Lane) -> Result<()> {
        let running: Vec<String> = self
            .runtime
            .locked()
            .iter()
            .filter(|(key, rt)| bot_of(key) == bot_id && rt.lane.as_ref() == Some(lane))
            .map(|(key, _)| key.clone())
            .collect();
        let here = actor_key(bot_id, lane);
        self.each_actor(bot_id, |home| *home == *lane, || Cmd::Stop)?;
        for key in running.into_iter().filter(|k| *k != here) {
            self.send_to_actor(&key, Cmd::Stop)?;
        }
        Ok(())
    }

    /// Takes back a message the user sent that still waits in one of the bot's places. Every actor is asked: the
    /// one that queued it may serve another place (a routine run in a thread). Whether one had it.
    pub async fn unsend(&self, bot_id: &str, entry_id: &str) -> Result<bool> {
        let answers = self.actor_txs(bot_id, |_| true)?.into_iter().filter_map(|tx| {
            let (reply, answer) = oneshot::channel();
            tx.send(Cmd::Unsend { entry_id: entry_id.to_owned(), reply }).ok().map(|()| answer)
        });
        Ok(futures::future::join_all(answers).await.into_iter().any(|a| matches!(a, Ok(true))))
    }

    /// Whether the bot has an actor of its own for `home`.
    pub fn has_place(&self, bot_id: &str, home: &Lane) -> bool {
        self.bots.locked().get(bot_id).is_some_and(|a| a.places.contains_key(&actor_key(bot_id, home)))
    }

    fn deliver(&self, bot_id: &str, home: &Lane, cmd: Cmd) -> Result<()> {
        self.actor_tx(bot_id, home)?.send(cmd).map_err(|_| anyhow!("bot stopped"))
    }

    /// Sends `make()` to each running actor of the bot whose place passes `serves`. Fails only for an unknown bot,
    /// or when every actor it reached had stopped.
    fn each_actor(&self, bot_id: &str, serves: impl Fn(&Lane) -> bool, make: impl Fn() -> Cmd) -> Result<()> {
        let txs = self.actor_txs(bot_id, serves)?;
        let reached = txs.iter().filter(|tx| tx.send(make()).is_ok()).count();
        if reached == 0 && !txs.is_empty() {
            return Err(anyhow!("bot stopped"));
        }
        Ok(())
    }

    /// The channels to the bot's running actors whose place passes `serves`.
    fn actor_txs(&self, bot_id: &str, serves: impl Fn(&Lane) -> bool) -> Result<Vec<mpsc::UnboundedSender<Cmd>>> {
        let bots = self.bots.locked();
        let actors = bots.get(bot_id).ok_or_else(|| anyhow!("unknown bot"))?;
        Ok(actors.places.values().filter(|(home, _)| serves(home)).map(|(_, h)| h.tx.clone()).collect())
    }

    /// The actor whose turn talks in `lane` right now, else the one that serves it.
    fn actor_in(&self, bot_id: &str, lane: &Lane) -> String {
        let runtime = self.runtime.locked();
        runtime
            .iter()
            .find(|(key, rt)| bot_of(key) == bot_id && rt.lane.as_ref() == Some(lane))
            .map_or_else(|| actor_key(bot_id, lane), |(key, _)| key.clone())
    }

    /// The channel to the bot's actor for `home`, starting the actor on first use.
    fn actor_tx(&self, bot_id: &str, home: &Lane) -> Result<mpsc::UnboundedSender<Cmd>> {
        let key = actor_key(bot_id, home);
        let dreamer = {
            let bots = self.bots.locked();
            let actors = bots.get(bot_id).ok_or_else(|| anyhow!("unknown bot"))?;
            if let Some((_, h)) = actors.places.get(&key) {
                return Ok(h.tx.clone());
            }
            actors.dreamer.clone()
        };
        let cfg = self.store.bot(bot_id)?.filter(|r| !r.deleted).ok_or_else(|| anyhow!("unknown bot"))?.config;
        let hub = self.me.upgrade().ok_or_else(|| anyhow!("the host is shutting down"))?;
        // Started outside the lock: an actor's first steps update its runtime, which emits the bot.
        let handle = bot::spawn(hub, cfg, home.clone(), dreamer);
        let mut bots = self.bots.locked();
        let Some(actors) = bots.get_mut(bot_id) else {
            let _ = handle.tx.send(Cmd::Shutdown);
            return Err(anyhow!("unknown bot"));
        };
        match actors.places.entry(key) {
            // Another command started it meanwhile.
            Entry::Occupied(running) => {
                let _ = handle.tx.send(Cmd::Shutdown);
                Ok(running.get().1.tx.clone())
            }
            Entry::Vacant(slot) => Ok(slot.insert((home.clone(), handle)).1.tx.clone()),
        }
    }

    /// The bot as clients see it: its own chat's state while that is busy, else a place waiting on the user,
    /// else one at work, else its own chat's (idle, or how its last turn ended). Fast mode is the bot's.
    pub fn bot_runtime(&self, bot_id: &str) -> Runtime {
        let runtime = self.runtime.locked();
        let main = runtime.get(bot_id).cloned().unwrap_or_default();
        if matches!(main.status, BotStatus::Working | BotStatus::NeedsInput) {
            return main;
        }
        let others = || runtime.iter().filter(|(key, _)| *key != bot_id && bot_of(key) == bot_id).map(|(_, rt)| rt);
        let busy = others()
            .find(|rt| rt.status == BotStatus::NeedsInput)
            .or_else(|| others().find(|rt| rt.status == BotStatus::Working));
        busy.map_or(main.clone(), |rt| Runtime { fast_mode: main.fast_mode.clone(), ..rt.clone() })
    }

    /// Where the bot (or, for a group, its members in it) is working right now.
    pub fn working_lanes(&self, cfg: &BotConfig) -> Vec<Lane> {
        let runtime = self.runtime.locked();
        let mut lanes: Vec<Lane> = runtime
            .iter()
            .filter(|(key, rt)| {
                let bot = bot_of(key);
                let mine = if cfg.is_group() { cfg.members.iter().any(|m| m == bot) } else { bot == cfg.id };
                mine && matches!(rt.status, BotStatus::Working | BotStatus::NeedsInput)
            })
            .filter_map(|(_, rt)| rt.lane.clone())
            .filter(|lane| !cfg.is_group() || lane.chat == cfg.id)
            .collect();
        lanes.sort_by_key(Lane::key);
        lanes.dedup();
        lanes
    }

    /// A group is busy while one of its members works in it: that member's status and activity.
    pub(super) fn group_runtime(&self, group: &BotConfig) -> Runtime {
        let busy = {
            let runtime = self.runtime.locked();
            runtime.iter().find_map(|(key, r)| {
                let member = bot_of(key);
                (group.members.iter().any(|m| m == member)
                    && r.status != BotStatus::Idle
                    && r.lane.as_ref().is_some_and(|l| l.chat == group.id))
                .then(|| (member.to_owned(), r.clone()))
            })
        };
        let Some((member, mut r)) = busy else { return Runtime::default() };
        let name = self.bot_name(&member);
        r.activity = if r.activity.is_empty() { name } else { format!("{name}: {}", r.activity) };
        r
    }
}

#[cfg(test)]
mod tests {
    use crate::agent::config::FastModeSupport;
    use crate::hub::{BotStatus, Hub};
    use crate::remote::identity::Identity;
    use crate::store::{Lane, Store};

    #[tokio::test]
    async fn a_bot_shows_a_working_place_over_how_its_chat_last_ended() {
        let dir = std::env::temp_dir().join(format!("kith-actors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let hub = Hub::new(store, "actors-test".into(), Identity::load_or_create(&dir).unwrap(), "test".into(), 0);
        hub.set_runtime("b", |r| {
            r.status = BotStatus::Error;
            r.fast_mode = FastModeSupport::Unsupported;
        });
        assert_eq!(hub.bot_runtime("b").status, BotStatus::Error);

        hub.set_runtime("b|b/root", |r| {
            r.status = BotStatus::Working;
            r.lane = Some(Lane::in_thread("b", "root"));
        });
        let shown = hub.bot_runtime("b");
        assert_eq!(shown.status, BotStatus::Working, "a thread at work outranks the chat's failed turn");
        assert_eq!(shown.lane, Some(Lane::in_thread("b", "root")));
        assert_eq!(shown.fast_mode, FastModeSupport::Unsupported, "Fast mode is the bot's");

        hub.set_runtime("b", |r| r.status = BotStatus::NeedsInput);
        assert_eq!(hub.bot_runtime("b").status, BotStatus::NeedsInput, "the chat while it's busy");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
