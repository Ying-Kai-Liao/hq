//! A bot's actors, one per place it talks (see `agent::bot`): started by the first command for a
//! place, addressed by the place a command concerns, and seen by clients as one bot.

use super::{BotStatus, Hub, Runtime};
use crate::LockExt;
use crate::agent::bot::{self, BotHandle, Cmd, actor_key, bot_of, place_of};
use crate::chat::memory;
use crate::store::{BotConfig, Lane};
use anyhow::{Result, anyhow};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

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
        let dreamer = memory::spawn_dreamer(self.clone(), id.clone());
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

    /// Stops all of a deleted bot's actors and forgets their state.
    pub(super) fn remove_bot_actors(&self, id: &str) {
        let _ = self.send_cmd(id, Cmd::Shutdown);
        self.bots.locked().remove(id);
        self.runtime.locked().retain(|key, _| bot_of(key) != id);
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
                self.send_to_actor(&key, cmd)
            }
            Cmd::CancelGroup { chat } => {
                self.each_actor(bot_id, |home| home.chat == chat, || Cmd::CancelGroup { chat: chat.clone() })
            }
            Cmd::Stop => self.each_actor(bot_id, |_| true, || Cmd::Stop),
            Cmd::RefreshTools => self.each_actor(bot_id, |_| true, || Cmd::RefreshTools),
            Cmd::Shutdown => self.each_actor(bot_id, |_| true, || Cmd::Shutdown),
            Cmd::Reconfigure(cfg) => self.each_actor(bot_id, |_| true, || Cmd::Reconfigure(cfg.clone())),
            cmd => self.deliver(bot_id, &Lane::main(bot_id), cmd),
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

    fn deliver(&self, bot_id: &str, home: &Lane, cmd: Cmd) -> Result<()> {
        self.actor_tx(bot_id, home)?.send(cmd).map_err(|_| anyhow!("bot stopped"))
    }

    /// Sends `make()` to each running actor of the bot whose place passes `serves`. Fails only for an unknown bot,
    /// or when every actor it reached had stopped.
    fn each_actor(&self, bot_id: &str, serves: impl Fn(&Lane) -> bool, make: impl Fn() -> Cmd) -> Result<()> {
        let txs: Vec<_> = {
            let bots = self.bots.locked();
            let actors = bots.get(bot_id).ok_or_else(|| anyhow!("unknown bot"))?;
            actors.places.values().filter(|(home, _)| serves(home)).map(|(_, h)| h.tx.clone()).collect()
        };
        let reached = txs.iter().filter(|tx| tx.send(make()).is_ok()).count();
        if reached == 0 && !txs.is_empty() {
            return Err(anyhow!("bot stopped"));
        }
        Ok(())
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
    /// else one at work, else its own chat's. Fast mode is the bot's.
    pub fn bot_runtime(&self, bot_id: &str) -> Runtime {
        let runtime = self.runtime.locked();
        let main = runtime.get(bot_id).cloned().unwrap_or_default();
        if main.status != BotStatus::Idle {
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
