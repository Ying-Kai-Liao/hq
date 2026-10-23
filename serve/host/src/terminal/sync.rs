//! Keeps threads in step with the terminal registry: creating them, importing the transcript, saying who writes.

use super::jsonl::{self, Item};
use super::registry::{self, Live, Registry};
use super::{Env, HeldByWriter, TerminalBusy};
use crate::LockExt;
use crate::agent::folder::Pick;
use crate::hub::Hub;
use crate::store::{BotConfig, EntryKind, Lane, ReadScope, lane_key, now_ms};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// How often the registry is looked at.
const EVERY: Duration = Duration::from_secs(3);
/// Entries kept of a transcript's start when it is first imported; older ones stay in the terminal's transcript.
const FIRST_IMPORT: usize = 400;
/// Entries one later import may bring.
const LATER_IMPORT: usize = 4000;
/// How long a take-over waits for the terminal's process to end.
const EXIT_WAIT: Duration = Duration::from_secs(5);

/// The summary keys the terminal owns; entries don't produce them.
const SUMMARY_KEYS: [&str; 6] = ["origin", "originLabel", "originBot", "liveWriter", "liveBusy", "terminal"];

/// Keeps the terminal's keys of `old` (a root's `data.thread`) in a fresh `summary` counted from entries.
pub fn carry_over(old: &Value, summary: &mut Value) {
    for key in SUMMARY_KEYS {
        if !old[key].is_null() {
            summary[key] = old[key].clone();
        }
    }
}

/// A thread: a task root in a bot's chat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thread {
    pub bot: String,
    pub root: String,
}

impl Thread {
    fn key(&self) -> String {
        format!("{}/{}", self.bot, self.root)
    }

    fn lane(&self) -> Lane {
        Lane::in_thread(&self.bot, &self.root)
    }

    fn parse(key: &str) -> Option<Self> {
        let (bot, root) = key.split_once('/')?;
        Some(Self { bot: bot.to_owned(), root: root.to_owned() })
    }
}

fn sid_key(sid: &str) -> String {
    format!("terminal.sid.{sid}")
}
fn info_key(t: &Thread) -> String {
    format!("terminal.info.{}", t.key())
}
fn cursor_key(t: &Thread) -> String {
    format!("terminal.cursor.{}", t.key())
}
fn final_key(t: &Thread) -> String {
    format!("terminal.final.{}", t.key())
}
fn live_key(t: &Thread) -> String {
    format!("terminal.live.{}", t.key())
}

/// Looks at the registry now and then, for as long as the host lives.
pub fn start(hub: &Arc<Hub>) {
    // Unit tests build hubs of their own and never watch this computer's terminals.
    if cfg!(test) {
        return;
    }
    let hub = hub.clone();
    tokio::spawn(async move {
        loop {
            let h = hub.clone();
            if let Err(error) = tokio::task::spawn_blocking(move || scan(&h)).await {
                tracing::warn!(%error, "terminal scan failed");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// One pass over the registry. Idempotent: a session is a thread once, and only new transcript lines are imported.
pub fn scan(hub: &Hub) {
    let env = hub.terminal.env();
    let mut seen = Vec::new();
    for reg in registry::read_all(&env.state) {
        match sync_session(hub, &env, &reg) {
            Ok(Some(thread)) => seen.push(thread),
            Ok(None) => {}
            Err(error) => tracing::warn!(error = format!("{error:#}"), "couldn't sync a terminal session"),
        }
    }
    // Threads whose registry file went away are closed.
    for key in hub.store.kv_prefix("terminal.info.") {
        let Some(thread) = Thread::parse(&key["terminal.info.".len()..]) else { continue };
        if !seen.contains(&thread) {
            update_state(hub, &env, &thread, None);
        }
    }
}

fn sync_session(hub: &Hub, env: &Env, reg: &Registry) -> Result<Option<Thread>> {
    let now = now_ms();
    let (thread, created) = if let Some(t) = mapped(hub, reg) {
        (t, false)
    } else {
        let Some(bot) = owner_bot(hub, &reg.agent) else { return Ok(None) };
        let Some(size) = transcript_size(reg) else { return Ok(None) };
        let age = now - reg.started_ms().max(modified_ms(reg));
        if age > registry::MAX_AGE_MS || hub.terminal.empty.locked().get(&reg.session_id) == Some(&size) {
            return Ok(None);
        }
        let Some(t) = create_thread(hub, env, reg, &bot)? else {
            hub.terminal.empty.locked().insert(reg.session_id.clone(), size);
            return Ok(None);
        };
        (t, true)
    };
    hub.store.kv_set(&info_key(&thread), &serde_json::to_string(reg)?)?;
    if !created && !host_writing(hub, &thread) {
        import(hub, &thread, reg)?;
    }
    update_state(hub, env, &thread, Some(reg));
    Ok(Some(thread))
}

fn transcript_size(reg: &Registry) -> Option<u64> {
    std::fs::metadata(reg.transcript()).ok().map(|m| m.len())
}

fn modified_ms(reg: &Registry) -> i64 {
    std::fs::metadata(reg.transcript())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// The owner's bot of `agent`.
fn owner_bot(hub: &Hub, agent: &str) -> Option<BotConfig> {
    let rows = hub.store.bots().ok()?;
    rows.into_iter()
        .find(|r| !r.deleted && r.config.person.is_none() && r.config.hq_agent.as_deref() == Some(agent))
        .map(|r| r.config)
}

fn host_writing(hub: &Hub, t: &Thread) -> bool {
    hub.store.bot(&t.bot).ok().flatten().is_some_and(|r| hub.working_lanes(&r.config).contains(&t.lane()))
}

/// The thread a session already belongs to: by its own id, by the session it was resumed from, or because an app
/// thread's lane runs it (a thread resumed in the terminal).
fn mapped(hub: &Hub, reg: &Registry) -> Option<Thread> {
    let exists = |t: &Thread| hub.store.entry(&t.root).is_some_and(|e| e.bot_id == t.bot && e.thread_id.is_none());
    if let Some(t) = hub.store.kv_get(&sid_key(&reg.session_id)).and_then(|k| Thread::parse(&k)).filter(exists) {
        return Some(t);
    }
    let owned = |t: &Thread| {
        hub.store
            .bot(&t.bot)
            .ok()
            .flatten()
            .is_some_and(|r| r.config.person.is_none() && r.config.hq_agent.as_deref() == Some(reg.agent.as_str()))
    };
    // `--resume` keeps the session id; a fork names the session it came from.
    if let Some(from) = reg.resumed_from.as_deref().filter(|f| *f != reg.session_id)
        && let Some(t) = hub.store.kv_get(&sid_key(from)).and_then(|k| Thread::parse(&k)).filter(exists)
    {
        adopt(hub, &t, reg, true);
        return Some(t);
    }
    let lane_sessions = hub.store.kv_prefix("lane.session.");
    for key in lane_sessions {
        if hub.store.kv_get(&key).as_deref() != Some(reg.session_id.as_str()) {
            continue;
        }
        let Some((bot, rest)) = key["lane.session.".len()..].split_once('@') else { continue };
        let Some(root) = rest.strip_prefix(&format!("{bot}/")) else { continue };
        let t = Thread { bot: bot.to_owned(), root: root.to_owned() };
        if exists(&t) && owned(&t) {
            adopt(hub, &t, reg, false);
            return Some(t);
        }
    }
    if let Some(from) = reg.resumed_from.as_deref().filter(|f| *f != reg.session_id) {
        // An app thread resumed in a terminal that forked the session.
        for key in hub.store.kv_prefix("lane.session.") {
            if hub.store.kv_get(&key).as_deref() != Some(from) {
                continue;
            }
            let Some((bot, rest)) = key["lane.session.".len()..].split_once('@') else { continue };
            let Some(root) = rest.strip_prefix(&format!("{bot}/")) else { continue };
            let t = Thread { bot: bot.to_owned(), root: root.to_owned() };
            if exists(&t) && owned(&t) {
                adopt(hub, &t, reg, true);
                return Some(t);
            }
        }
    }
    None
}

/// Makes `reg`'s session the one of an existing thread. A forked session becomes the thread's lane session, in the
/// folder it ran in, so the host carries on from where the terminal left it.
fn adopt(hub: &Hub, t: &Thread, reg: &Registry, forked: bool) {
    let result = (|| -> Result<()> {
        hub.store.kv_set(&sid_key(&reg.session_id), &t.key())?;
        if forked {
            hub.store.kv_set(&lane_key("session", &t.bot, &t.lane()), &reg.session_id)?;
            Pick::save(&hub.store, &t.bot, &t.lane(), Some(&Pick::Folder(reg.cwd.clone())))?;
            // The fork starts as a copy of what the thread already has.
            hub.store.kv_delete(&cursor_key(t))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(error = format!("{error:#}"), "couldn't map a terminal session to its thread");
    }
}

/// What `read_items` found.
struct Read {
    /// Items in order, the oldest dropped past the cap.
    items: Vec<Item>,
    dropped: usize,
    /// The first thing the user said, and where among all items.
    first_user: Option<(usize, Item)>,
    /// The offset after the last whole line read.
    end: u64,
}

/// Reads `path` from `from`, keeping at most `keep` items (the newest).
fn read_items(path: &Path, from: u64, since: i64, keep: usize) -> std::io::Result<Read> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut out = Read { items: Vec::new(), dropped: 0, first_user: None, end: from };
    let mut kept: VecDeque<Item> = VecDeque::new();
    let (mut carry, mut buf, mut index) = (Vec::new(), vec![0u8; 4 << 20], 0usize);
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let parsed = jsonl::parse(&carry, since);
        carry.drain(..parsed.consumed);
        out.end += parsed.consumed as u64;
        for item in parsed.items {
            if out.first_user.is_none() && matches!(item, Item::User { .. }) {
                out.first_user = Some((index, item.clone()));
            }
            index += 1;
            kept.push_back(item);
            if kept.len() > keep {
                kept.pop_front();
                out.dropped += 1;
            }
        }
    }
    out.items = kept.into();
    Ok(out)
}

/// A new thread for a session with something the user said; None while it has none yet.
fn create_thread(hub: &Hub, env: &Env, reg: &Registry, bot: &BotConfig) -> Result<Option<Thread>> {
    let Ok(read) = read_items(reg.transcript(), 0, 0, FIRST_IMPORT) else { return Ok(None) };
    let Some((first_index, Item::User { text, at })) = read.first_user.clone() else { return Ok(None) };
    let live = registry::liveness(reg, env.sessions.as_deref()).is_live();
    let turn = hub.store.max_turn(&bot.id) + 1;
    let data = json!({
        "text": cap_text(&text),
        "task": true,
        "status": "sent",
        "clientNonce": "",
        "attachments": [],
        "thread": thread_value(reg, "terminal", live, false),
    });
    let root = hub
        .add_entry_at(&Lane::main(&bot.id), EntryKind::User, turn, &data, at)
        .ok_or_else(|| anyhow!("couldn't save the thread"))?;
    let thread = Thread { bot: bot.id.clone(), root: root.id };
    hub.store.kv_set(&sid_key(&reg.session_id), &thread.key())?;
    hub.store.kv_set(&lane_key("session", &thread.bot, &thread.lane()), &reg.session_id)?;
    Pick::save(&hub.store, &thread.bot, &thread.lane(), Some(&Pick::Folder(reg.cwd.clone())))?;
    hub.store.kv_set(&info_key(&thread), &serde_json::to_string(reg)?)?;
    hub.store.kv_set(&live_key(&thread), if live { "1" } else { "0" })?;
    writer_notice(hub, &thread, "startedInTerminal", "Started in the terminal", at);
    let mut items = read.items;
    let mut dropped = read.dropped > 0;
    if first_index >= read.dropped {
        items.remove(first_index - read.dropped);
    } else {
        dropped = true;
    }
    if dropped {
        notice(hub, &thread, "Earlier messages are in the terminal transcript.", at);
    }
    apply(hub, &thread, &items, live);
    hub.store.kv_set(&cursor_key(&thread), &read.end.to_string())?;
    done_importing(hub, &thread);
    Ok(Some(thread))
}

/// The root's `data.thread` of a new terminal thread.
fn thread_value(reg: &Registry, origin: &str, live: bool, busy: bool) -> Value {
    json!({
        "count": 0, "lastAt": 0, "authors": [], "unread": 0,
        "origin": origin,
        "liveWriter": if live { json!("terminal") } else { Value::Null },
        "liveBusy": busy,
        "terminal": {"sessionId": reg.session_id, "cwd": reg.cwd},
    })
}

/// Imports what the transcript gained since the cursor. A thread that has none yet (an app thread a terminal
/// resumed) reads the lines newer than the thread's own newest entry.
fn import(hub: &Hub, t: &Thread, reg: &Registry) -> Result<()> {
    let Some(size) = transcript_size(reg) else { return Ok(()) };
    let live = registry::liveness(reg, hub.terminal.env().sessions.as_deref()).is_live();
    let (from, since, keep) = match hub.store.kv_get(&cursor_key(t)).and_then(|c| c.parse::<u64>().ok()) {
        Some(c) if c > size => {
            hub.store.kv_set(&cursor_key(t), &size.to_string())?;
            return Ok(());
        }
        Some(c) if c == size => return Ok(()),
        Some(c) => (c, 0, LATER_IMPORT),
        None => (0, newest_at(hub, t), FIRST_IMPORT),
    };
    let first = from == 0 && since > 0;
    let read = read_items(reg.transcript(), from, since, keep)?;
    if first && read.dropped > 0 {
        notice(hub, t, "Earlier messages are in the terminal transcript.", now_ms());
    }
    apply(hub, t, &read.items, live);
    hub.store.kv_set(&cursor_key(t), &read.end.to_string())?;
    done_importing(hub, t);
    Ok(())
}

/// When the thread last changed (ms).
fn newest_at(hub: &Hub, t: &Thread) -> i64 {
    let last = hub.store.thread(&t.bot, &t.root, 1).ok().and_then(|v| v.last().map(|e| e.updated_at));
    last.or_else(|| hub.store.entry(&t.root).map(|e| e.created_at)).unwrap_or(0)
}

fn done_importing(hub: &Hub, t: &Thread) {
    hub.refresh_thread_summary(&t.bot, &t.root);
    // Read in the terminal already.
    if let Err(error) = hub.mark_read(&t.bot, ReadScope::Thread(&t.root)) {
        tracing::warn!(%error, "couldn't mark a terminal thread read");
    }
}

fn cap_text(text: &str) -> String {
    text.chars().take(8000).collect()
}

fn notice(hub: &Hub, t: &Thread, text: &str, at: i64) {
    let turn = hub.store.max_turn(&t.bot);
    hub.add_entry_at(&t.lane(), EntryKind::Notice, turn, &json!({"text": text, "style": "divider"}), at);
}

/// A notice for the apps' time-separator: `writerChange` says who started or stopped writing.
fn writer_notice(hub: &Hub, t: &Thread, change: &str, text: &str, at: i64) {
    let turn = hub.store.max_turn(&t.bot);
    let data = json!({"text": text, "style": "divider", "writerChange": change, "at": at});
    hub.add_entry_at(&t.lane(), EntryKind::Notice, turn, &data, at);
}

/// Adds `items` to the thread as entries. `live`: a tool without an outcome yet is still running.
fn apply(hub: &Hub, t: &Thread, items: &[Item], live: bool) {
    let mut tools: Option<HashMap<String, String>> = None;
    let mut final_id = hub.store.kv_get(&final_key(t)).filter(|s| !s.is_empty());
    let lane = t.lane();
    let unfinal = |final_id: &mut Option<String>| {
        if let Some(id) = final_id.take()
            && let Some(mut e) = hub.store.entry(&id)
        {
            e.data["final"] = false.into();
            hub.set_entry(&id, &e.data);
        }
    };
    for (i, item) in items.iter().enumerate() {
        let turn = hub.store.max_turn(&t.bot);
        match item {
            Item::User { text, at } => {
                let data = json!({"text": cap_text(text), "status": "sent", "clientNonce": "", "attachments": []});
                hub.add_entry_at(&lane, EntryKind::User, turn + 1, &data, *at);
            }
            Item::Agent { text, at } => {
                unfinal(&mut final_id);
                let data = json!({"text": text, "final": true});
                final_id = hub.add_entry_at(&lane, EntryKind::Agent, turn, &data, *at).map(|e| e.id);
            }
            Item::Thought { text, at } => {
                unfinal(&mut final_id);
                hub.add_entry_at(&lane, EntryKind::Thought, turn, &json!({"text": text}), *at);
            }
            Item::ToolUse { id, title, kind, at } => {
                unfinal(&mut final_id);
                let answered = items[i + 1..].iter().any(|x| matches!(x, Item::ToolResult { id: r, .. } if r == id));
                let status = if answered || !live { "completed" } else { "pending" };
                let data = json!({
                    "toolCallId": id, "title": title, "toolKind": kind, "status": status,
                    "output": "", "diffs": [], "locations": null,
                });
                if let Some(e) = hub.add_entry_at(&lane, EntryKind::Tool, turn, &data, *at)
                    && let Some(map) = tools.as_mut()
                {
                    map.insert(id.clone(), e.id);
                }
            }
            Item::ToolResult { id, output, failed } => {
                let map = tools.get_or_insert_with(|| tool_entries(hub, t));
                let Some(mut e) = map.get(id).and_then(|e| hub.store.entry(e)) else { continue };
                e.data["status"] = if *failed { "failed" } else { "completed" }.into();
                e.data["output"] = output.clone().into();
                hub.set_entry(&e.id, &e.data);
            }
        }
    }
    let stored = final_id.unwrap_or_default();
    if let Err(error) = hub.store.kv_set(&final_key(t), &stored) {
        tracing::warn!(%error, "couldn't keep the final reply of a terminal thread");
    }
}

/// The thread's tool entries by the tool call they show.
fn tool_entries(hub: &Hub, t: &Thread) -> HashMap<String, String> {
    hub.store
        .thread(&t.bot, &t.root, 600)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.kind == EntryKind::Tool.as_str())
        .filter_map(|e| Some((e.data["toolCallId"].as_str()?.to_owned(), e.id)))
        .collect()
}

/// Brings the root's writer fields and the writer-change notices in line with the terminal. `reg` None: the
/// session's registry file is gone.
fn update_state(hub: &Hub, env: &Env, t: &Thread, reg: Option<&Registry>) {
    let reg = reg.cloned().or_else(|| info(hub, t));
    let live = reg.as_ref().map_or(Live::Closed, |r| registry::liveness(r, env.sessions.as_deref()));
    let was_live = hub.store.kv_get(&live_key(t)).as_deref() == Some("1");
    if live.is_live() != was_live {
        if hub.store.kv_set(&live_key(t), if live.is_live() { "1" } else { "0" }).is_ok() {
            let (change, text) = if live.is_live() {
                ("openedInTerminal", "Opened in the terminal")
            } else {
                ("terminalClosed", "Terminal closed")
            };
            writer_notice(hub, t, change, text, now_ms());
        }
        hub.refresh_thread_summary(&t.bot, &t.root);
    }
    set_writer(hub, t, reg.as_ref(), live, host_writing(hub, t));
}

fn info(hub: &Hub, t: &Thread) -> Option<Registry> {
    registry::parse(&hub.store.kv_get(&info_key(t))?)
}

/// Writes `liveWriter`, `liveBusy` and `terminal` into the root's summary when they changed.
fn set_writer(hub: &Hub, t: &Thread, reg: Option<&Registry>, live: Live, host: bool) {
    let Some(mut root) = hub.store.entry(&t.root) else { return };
    let writer = match (live.is_live(), host) {
        (true, _) => json!("terminal"),
        (false, true) => json!("app"),
        (false, false) => Value::Null,
    };
    let busy = live == Live::Busy || (!live.is_live() && host);
    let mut summary = root.data["thread"].clone();
    if !summary.is_object() {
        summary = json!({});
    }
    summary["liveWriter"] = writer;
    summary["liveBusy"] = busy.into();
    if let Some(r) = reg {
        summary["terminal"] = json!({"sessionId": r.session_id, "cwd": r.cwd});
    }
    if root.data["thread"] != summary {
        root.data["thread"] = summary;
        hub.set_entry(&t.root, &root.data);
    }
}

/// A host turn on `lane` ended: what it wrote to the transcript is already in the thread, so the cursor moves to the
/// end of the file.
pub fn host_turn_ended(hub: &Hub, lane: &Lane) {
    let Some(root) = &lane.thread else { return };
    let t = Thread { bot: lane.chat.clone(), root: root.clone() };
    let Some(reg) = info(hub, &t) else { return };
    if let Some(size) = transcript_size(&reg)
        && let Err(error) = hub.store.kv_set(&cursor_key(&t), &size.to_string())
    {
        tracing::warn!(%error, "couldn't move a terminal thread's cursor");
    }
}

/// The thread of a message (`threadId`) when it is a terminal thread, refused while another writer holds it. A
/// closed terminal's last lines are imported first, so the host carries on from the whole conversation.
pub fn before_send(hub: &Hub, bot: &str, root: &str) -> Result<()> {
    let t = Thread { bot: bot.to_owned(), root: root.to_owned() };
    let Some(reg) = info(hub, &t) else { return Ok(()) };
    let env = hub.terminal.env();
    if hub.terminal.taking.locked().contains(&t.key()) || registry::liveness(&reg, env.sessions.as_deref()).is_live() {
        return Err(HeldByWriter { code: "liveInTerminal" }.into());
    }
    if let Err(error) = import(hub, &t, &reg) {
        tracing::warn!(error = format!("{error:#}"), "couldn't catch up a terminal thread before a send");
    }
    Ok(())
}

/// What the kernel needs to resume a thread: `{botId, threadId, agent, sessionId, cwd, hostBusy}` for a thread id or
/// a session id.
pub async fn resolve(hub: &Hub, which: &str) -> Value {
    let unknown = || json!({"error": "unknown thread"});
    let entry = hub.store.entry(which);
    let thread = match entry {
        Some(e) => Some(Thread { bot: e.bot_id.clone(), root: e.thread_id.clone().unwrap_or(e.id.clone()) }),
        None => hub.store.kv_get(&sid_key(which)).and_then(|k| Thread::parse(&k)).or_else(|| lane_owner(hub, which)),
    };
    let Some(t) = thread else { return unknown() };
    let Some(row) = hub.store.bot(&t.bot).ok().flatten().filter(|r| !r.deleted && r.config.person.is_none()) else {
        return unknown();
    };
    let root_ok = hub.store.entry(&t.root).is_some_and(|e| e.bot_id == t.bot && e.thread_id.is_none());
    let session = hub.store.kv_get(&lane_key("session", &t.bot, &t.lane())).filter(|s| !s.is_empty());
    let (true, Some(session), Some(agent)) = (root_ok, session, row.config.hq_agent.clone()) else {
        return unknown();
    };
    let cwd = crate::agent::folder::resolve(&hub.store, &row.config, &t.lane()).await.cwd;
    json!({
        "botId": t.bot, "threadId": t.root, "agent": agent, "sessionId": session, "cwd": cwd,
        "hostBusy": hub.working_lanes(&row.config).contains(&t.lane()),
    })
}

/// The thread whose lane runs session `sid`.
fn lane_owner(hub: &Hub, sid: &str) -> Option<Thread> {
    hub.store.kv_prefix("lane.session.").into_iter().find_map(|key| {
        (hub.store.kv_get(&key).as_deref() == Some(sid)).then_some(())?;
        let (bot, rest) = key["lane.session.".len()..].split_once('@')?;
        let root = rest.strip_prefix(&format!("{bot}/"))?;
        Some(Thread { bot: bot.to_owned(), root: root.to_owned() })
    })
}

/// Ends the terminal that holds the thread so the host can write: refused while the terminal works, a no-op when it
/// is already closed. Returns the thread's new writer.
pub async fn take_over(hub: &Arc<Hub>, bot: &str, root: &str) -> Result<Value> {
    let t = Thread { bot: bot.to_owned(), root: root.to_owned() };
    let row = hub.store.bot(bot)?.filter(|r| !r.deleted && r.config.person.is_none());
    anyhow::ensure!(row.is_some() && info(hub, &t).is_some(), "unknown thread");
    if !hub.terminal.taking.locked().insert(t.key()) {
        // A second tap while the first runs.
        return Ok(json!({"liveWriter": null, "tookOver": false}));
    }
    let result = take_over_inner(hub, &t).await;
    hub.terminal.taking.locked().remove(&t.key());
    result
}

async fn take_over_inner(hub: &Arc<Hub>, t: &Thread) -> Result<Value> {
    let env = hub.terminal.env();
    let reg = info(hub, t).ok_or_else(|| anyhow!("unknown thread"))?;
    match registry::liveness(&reg, env.sessions.as_deref()) {
        Live::Closed => return Ok(json!({"liveWriter": null, "tookOver": false})),
        Live::Busy => return Err(TerminalBusy("terminalBusy: The terminal is working. Wait for it to finish.").into()),
        Live::Idle => {}
    }
    // The terminal reads this to tell its user where the conversation went.
    let taken = registry::dir(&env.state).join(format!("{}.taken", reg.session_id));
    write_private(&taken, &chrono::Utc::now().to_rfc3339())?;
    // Re-checked just before the signal: the pid may have changed hands.
    if registry::liveness(&reg, env.sessions.as_deref()) != Live::Idle || !registry::terminate(reg.pid) {
        return Err(TerminalBusy("terminalBusy: The terminal changed while taking over. Try again.").into());
    }
    let deadline = tokio::time::Instant::now() + EXIT_WAIT;
    while registry::pid_runs(reg.pid) {
        if tokio::time::Instant::now() >= deadline {
            return Err(TerminalBusy("terminalBusy: The terminal didn't close. Close it yourself.").into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The terminal's last lines, before the host writes after them.
    let (h, thread, r) = (hub.clone(), t.clone(), reg);
    tokio::task::spawn_blocking(move || {
        if let Err(error) = import(&h, &thread, &r) {
            tracing::warn!(error = format!("{error:#}"), "couldn't import a terminal's last lines");
        }
        // Said here, so the scan doesn't also say the terminal closed.
        if h.store.kv_set(&live_key(&thread), "0").is_ok() {
            writer_notice(&h, &thread, "tookOver", "Taken over in the app", now_ms());
        }
        set_writer(&h, &thread, Some(&r), Live::Closed, false);
    })
    .await?;
    Ok(json!({"liveWriter": null, "tookOver": true}))
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    use std::io::Write as _;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt as _;
    let tmp = path.with_extension("taken.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    opts.open(&tmp)?.write_all(text.as_bytes())?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
