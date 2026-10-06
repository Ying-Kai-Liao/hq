//! A bot's long-term memory, modeled on Grok Bot's: plain markdown facts in
//! `~/.codync/bots/<id>/memory/`: `profile.md` (who the user is, kept in mind
//! every turn) and `log/YYYY-MM.md` (dated history), one `- (YYYY-MM-DD) fact`
//! per line, so the user and the agent can read, grep and edit them.
//!
//! Memorable exchanges queue up for the bot's *keeper*, which runs a one-shot agent
//! of the same harness over them once the bot goes quiet and extracts facts
//! (`profile:` / `log:` / `note:` / `remove:`); every [`EPISODE_INTERVAL`]
//! exchanges it also writes a one-line `[episode]` journal entry, and a profile
//! that outgrows the prompt is consolidated. The bot sees memory through its
//! frozen prompt (`context`) and searches its full chat with `search_history`.

mod extract;
mod facts;
mod keeper;
mod search;

pub use extract::{EpisodeTurn, is_memorable, set_pending_episode};
pub use facts::Memory;
pub(crate) use keeper::one_shot;
pub use keeper::{Exchange, spawn_keeper};
pub use search::{INSTRUCTIONS, call, tools};

use anyhow::Result;
use facts::{Fact, Recall, ymd};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

const PROFILE_FILE: &str = "profile.md";
const LOG_DIR: &str = "log";
const PROFILE_HEADER: &str =
    "# About the user\n\n<!-- Enduring facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";
const LOG_HEADER: &str = "# Memory log\n\n<!-- Dated facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";

/// Profile facts shown in the prompt; past this the keeper consolidates the profile.
const PROFILE_PROMPT_LIMIT: usize = 100;
/// What a consolidation merges the profile down to, leaving room to grow.
const PROFILE_TARGET: usize = 60;
/// Log facts shown in the prompt (newest first), within [`RECENT_CHAR_BUDGET`].
pub const RECENT_PROMPT_LIMIT: usize = 30;
const RECENT_CHAR_BUDGET: usize = 4_000;
const MAX_FACT_CHARS: usize = 500;
/// Archived facts scanned for ones relevant to an exchange (beyond those in the prompt).
const ARCHIVE_SCAN_LIMIT: usize = 500;
const RELEVANT_LIMIT: usize = 10;
/// Exchanges per `[episode]` journal line.
pub const EPISODE_INTERVAL: usize = 6;
/// An exchange side is cut to this before it goes to the keeper.
const EXCHANGE_CHARS: usize = 8_000;
const KEEPER_TIMEOUT: Duration = Duration::from_secs(180);
/// Quiet time after the last exchange before the keeper runs over the queued ones.
const KEEPER_IDLE: Duration = Duration::from_secs(5 * 60);
/// Queued exchanges that make the keeper run without waiting.
const KEEPER_BATCH: usize = 8;

const EPISODE_PREFIX: &str = "[episode] ";
const NOTE_PREFIX: &str = "[note] ";
const NONE: &str = "NONE";
const DAY_MS: i64 = 86_400_000;

/// Serializes writes to memory files (the keeper and the API both write).
static WRITES: Mutex<()> = Mutex::new(());

fn fact_line(f: &Fact) -> String {
    format!("- (learned {}) {}", ymd(f.created_at), f.content)
}

/// The memory section of the bot's instructions, and whether it holds any facts.
pub fn render(recall: &Recall, location: &Path) -> (String, bool) {
    let mut lines = vec![
        "Memory: durable facts you have learned about the user and their world.".to_owned(),
        "These persist across every session with this bot, even after a new session starts. Rely on them so you stay consistent and avoid re-asking what you already know.".to_owned(),
        format!(
            "Your memory lives in a folder at {}: {PROFILE_FILE} holds who the user is (kept in mind every turn) and {LOG_DIR}/ holds dated history.",
            location.display()
        ),
        "Read or grep those files when you need older facts that are not listed here, and use the search_history tool to find what was actually said in past chats. Memory is updated automatically in the background shortly after each conversation: when the user asks you to remember or forget something, just confirm it to them and it will be recorded.".to_owned(),
    ];
    if !recall.profile.is_empty() {
        lines.push("About the user:".into());
        lines.extend(recall.profile.iter().map(fact_line));
    }
    if !recall.recent.is_empty() {
        lines.push("Recently:".into());
        let mut budget = RECENT_CHAR_BUDGET;
        let mut shown = 0;
        for f in &recall.recent {
            let line = fact_line(f);
            if shown > 0 && line.len() > budget {
                break;
            }
            budget = budget.saturating_sub(line.len());
            lines.push(line);
            shown += 1;
        }
        let omitted = recall.recent.len() - shown;
        if omitted > 0 {
            lines.push(format!("({omitted} more log facts on disk — grep the {LOG_DIR}/ folder for them.)"));
        }
    }
    let has_facts = !recall.profile.is_empty() || !recall.recent.is_empty();
    if !has_facts {
        lines.push("No facts recorded yet.".into());
    }
    (lines.join("\n"), has_facts)
}

/// `memory` API: the facts a bot has, for the Memory screen.
pub fn describe(bot_id: &str) -> Result<Value> {
    let mem = Memory::for_bot(bot_id)?;
    Ok(json!({"location": mem.location(), "facts": mem.list(1_000)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn temp() -> Memory {
        let dir = std::env::temp_dir().join(format!("codync-memory-{}", uuid::Uuid::new_v4()));
        Memory::at(dir)
    }
}
