//! Bot memory ([design](../../../../docs/design/bot-memory.md)): it records the person, not the work. The rules
//! (store, checks, opening, dreaming) live in the `codync_mem` crate; this module runs them in the host: the
//! session opening, the bot's memory tools, the client API, the chat lines that show and undo a bot's writes,
//! dreaming, and the one-time move from the old Engram memory.

mod api;
mod dates;
mod dream;
mod import;
mod notices;
mod tools;

pub use api::call;
pub use dream::{DreamEvent, spawn_dreamer};
pub use import::import_old_memory;
pub use tools::{INSTRUCTIONS, call as tool_call, tools};

use crate::hub::Hub;
use crate::store::{BotConfig, Store};

/// Whether a bot uses the memory all bots share. Unless the user chose, a bot in its own workspace does and one
/// working in a project folder doesn't.
pub fn shared(cfg: &BotConfig) -> bool {
    cfg.shared_memory.unwrap_or_else(|| crate::agent::workspace::is_managed(cfg))
}

/// The memory section of a bot's instructions.
pub fn opening(store: &Store, cfg: &BotConfig) -> String {
    match store.memory_read(|c| codync_mem::opening::load(c, &cfg.id, shared(cfg))) {
        Ok(opening) => opening.render(),
        Err(error) => {
            tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't read memory");
            String::new()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    /// The user changed memory: every session of the bot hears it on its next turn.
    User,
    /// A bot or dreaming wrote it. The session that wrote it knows; others pick it up at their next compaction or
    /// new session.
    Background,
}

/// After memory changed in `bot`'s own layer, or in the shared one (`None`): clients fetch it again, and a change
/// the user made reaches the bots' sessions.
pub fn changed(hub: &Hub, bot: Option<&str>, change: Change) {
    let bots: Vec<String> = match bot {
        Some(bot) => vec![bot.to_owned()],
        None => hub
            .store
            .bots()
            .map(|rows| rows.into_iter().filter(|r| !r.deleted && !r.config.is_group()).map(|r| r.config.id).collect())
            .unwrap_or_default(),
    };
    let revision = hub.store.memory_rev().to_string();
    for id in &bots {
        if change == Change::User
            && let Err(error) = hub
                .store
                .kv_set(&revision_key(id), &revision)
                .and_then(|()| crate::chat::context::invalidate(&hub.store, id))
        {
            tracing::warn!(bot = %id, error = format!("{error:#}"), "couldn't flag the memory change");
        }
        hub.emit_bot(id);
    }
}

fn revision_key(bot: &str) -> String {
    format!("memory.revision.{bot}")
}

fn announced_key(bot: &str, session: &str) -> String {
    format!("memory.announced.{bot}.{session}")
}

/// When the user changed memory since this session last heard: the whole memory as it is now, to put before the
/// next message, and the revision to acknowledge once it was delivered.
pub fn change_notice(store: &Store, cfg: &BotConfig, session: &str) -> Option<(String, String)> {
    let revision = store.kv_get(&revision_key(&cfg.id)).unwrap_or_default();
    if revision.is_empty() || store.kv_get(&announced_key(&cfg.id, session)).unwrap_or_default() == revision {
        return None;
    }
    let notice = format!(
        "<memory_update>\nThe user changed your memory. This is all of it now and replaces any earlier memory in this conversation.\n{}\n</memory_update>",
        opening(store, cfg)
    );
    Some((notice, revision))
}

/// The session heard memory up to `revision`: from a notice, or from instructions rendered just now.
pub fn mark_announced(store: &Store, bot: &str, session: &str, revision: &str) -> anyhow::Result<()> {
    store.kv_set(&announced_key(bot, session), revision)
}

/// The revision a fresh session's instructions already include.
pub fn current_revision(store: &Store, bot: &str) -> String {
    store.kv_get(&revision_key(bot)).unwrap_or_default()
}
