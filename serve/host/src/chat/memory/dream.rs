//! Dreaming in the host: when a bot's run starts, what it reads, and running its model on the bot's own harness.
//! What a run may change is the crate's decision (`codync_mem::dream`).

use super::Change;
use crate::LockExt;
use crate::chat::{naming, oneshot};
use crate::hub::Hub;
use crate::store::{BotConfig, Entry, EntryKind, Store};
use anyhow::{Result, anyhow};
use codync_mem::dream::{self, Message, Outcome};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// Quiet time after the last turn before a run.
const IDLE: Duration = Duration::from_secs(5 * 60);
/// User messages that start a run without waiting, and the most one run reads.
const BATCH: usize = 8;
/// Entries (the user's messages and final replies) one run looks at.
const READ_LIMIT: i64 = 40;
const MESSAGE_CHARS: usize = 4_000;
/// Usage of the bot's plan above which runs wait, so dreaming never spends the user's last headroom.
const HEADROOM_PERCENT: f64 = 75.0;
/// How often an idle bot checks whether its daily time review is due.
const REVIEW_CHECK: Duration = Duration::from_secs(60 * 60);

pub enum DreamEvent {
    /// A turn the user started has finished.
    Turn(naming::Turn),
    /// Run soon: a new session started or the context was compacted.
    Flush,
}

enum Ran {
    /// Read up to here; more may wait.
    Done { more: bool },
    /// Try again later without counting a failure: usage is high, or memory changed during the run.
    Later,
}

fn bookmark_key(bot: &str) -> String {
    format!("memory.dream.{bot}")
}

fn reviewed_key(bot: &str) -> String {
    format!("memory.dream.reviewed.{bot}")
}

/// Dreaming starts reading after `seq`.
pub(super) fn set_bookmark(store: &Store, bot: &str, seq: i64) -> Result<()> {
    store.kv_set(&bookmark_key(bot), &seq.to_string())
}

fn bookmark(store: &Store, bot: &str) -> i64 {
    store.kv_get(&bookmark_key(bot)).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Starts the bot's dreamer. It runs once the bot has been quiet for [`IDLE`] after the user's turns, or right
/// away when [`BATCH`] of them are waiting, and once a day for the time review. It also names an unnamed bot. It
/// stops when the bot actor drops the sender; what it hasn't read waits for the next one.
pub fn spawn_dreamer(hub: Arc<Hub>, bot_id: String) -> mpsc::UnboundedSender<DreamEvent> {
    let (tx, mut rx) = mpsc::unbounded_channel::<DreamEvent>();
    tokio::spawn(async move {
        let mut waiting = waiting(&hub.store, &bot_id);
        let idle = tokio::time::sleep(IDLE);
        tokio::pin!(idle);
        let mut failures = 0u32;
        let mut retry_at: Option<Instant> = None;
        let quiet_until = |retry_at: Option<Instant>| {
            let after = Instant::now() + IDLE;
            retry_at.map_or(after, |at| at.max(after))
        };
        loop {
            let due = waiting > 0 || review_due(&hub.store, &bot_id);
            let run = tokio::select! {
                event = rx.recv() => match event {
                    None => break,
                    Some(DreamEvent::Turn(turn)) => {
                        if let Err(e) = naming::observe(&hub, &bot_id, turn).await {
                            tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "naming the bot failed");
                        }
                        waiting += 1;
                        idle.as_mut().reset(quiet_until(retry_at));
                        waiting >= BATCH && retry_at.is_none()
                    }
                    Some(DreamEvent::Flush) => {
                        idle.as_mut().reset(retry_at.unwrap_or_else(Instant::now));
                        false
                    }
                },
                () = &mut idle, if due => true,
                () = tokio::time::sleep(REVIEW_CHECK), if !due => false,
            };
            if !run {
                continue;
            }
            let next = match self::run(&hub, &bot_id).await {
                Ok(Ran::Done { more }) => {
                    failures = 0;
                    retry_at = None;
                    waiting = if more { waiting.max(1) } else { self::waiting(&hub.store, &bot_id) };
                    if more { Instant::now() } else { quiet_until(None) }
                }
                Ok(Ran::Later) => quiet_until(retry_at),
                Err(e) => {
                    failures += 1;
                    retry_at = Some(Instant::now() + IDLE * 2u32.pow(failures.min(5)));
                    tracing::warn!(bot = %bot_id, failures, error = format!("{e:#}"), "dreaming failed; it retries later");
                    quiet_until(retry_at)
                }
            };
            idle.as_mut().reset(next);
        }
    });
    tx
}

/// The user's messages since the bookmark.
fn waiting(store: &Store, bot: &str) -> usize {
    store
        .conversation_since(bot, bookmark(store, bot), READ_LIMIT)
        .map_or(0, |entries| entries.iter().filter(|e| e.kind == EntryKind::User.as_str()).count())
}

/// Once a day, when the bot's memory holds a dated entry it may rewrite (the time review).
fn review_due(store: &Store, bot: &str) -> bool {
    if store.kv_get(&reviewed_key(bot)).as_deref() == Some(today().as_str()) {
        return false;
    }
    store.memory_read(|c| codync_mem::store::layer(c, Some(bot))).is_ok_and(|entries| {
        entries.iter().any(|e| {
            e.state == codync_mem::store::State::Active && e.author != codync_mem::store::Author::User && dated(&e.text)
        })
    })
}

/// Whether a memory names a date the time review may have to turn into the past: a year, a month or day in
/// Chinese, or an English month next to a number. Other numbers (prices, counts) don't count.
fn dated(text: &str) -> bool {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let chars: Vec<char> = text.chars().collect();
    let year =
        chars.windows(4).any(|w| matches!(w[..2], ['1', '9'] | ['2', '0']) && w[2..].iter().all(char::is_ascii_digit));
    let cjk = chars.windows(2).any(|w| w[0].is_ascii_digit() && "年月日號号".contains(w[1]));
    let lower = text.to_lowercase();
    let english = MONTHS.iter().any(|m| lower.contains(m)) && chars.iter().any(char::is_ascii_digit);
    year || cjk || english
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

async fn run(hub: &Arc<Hub>, bot_id: &str) -> Result<Ran> {
    let Some(cfg) = hub.store.bot(bot_id)?.filter(|b| !b.deleted).map(|b| b.config) else {
        return Ok(Ran::Done { more: false });
    };
    if near_limit(hub, &cfg) {
        return Ok(Ran::Later);
    }
    let after = bookmark(&hub.store, bot_id);
    let entries = hub.store.conversation_since(bot_id, after, READ_LIMIT)?;
    let read = within_batch(&entries);
    let more = read.len() < entries.len() || i64::try_from(entries.len()).is_ok_and(|n| n == READ_LIMIT);
    let last_seq = read.last().map_or(after, |e| e.seq);
    let messages: Vec<Message> = read.iter().filter_map(message).collect();
    let today = today();
    let review = review_due(&hub.store, bot_id);
    let worth = messages.iter().any(|m| m.from_user && m.text.iter().any(|run| codync_mem::evidence::substantive(run)));
    if !worth && !review {
        set_bookmark(&hub.store, bot_id, last_seq)?;
        return Ok(Ran::Done { more });
    }

    let shared = super::shared(&cfg);
    let snapshot = hub.store.memory_read(|c| dream::snapshot(c, bot_id, shared, &today))?;
    let (system, material) = dream::prompt(&snapshot, &messages);
    let raw = oneshot::one_shot(hub, &cfg, &system, &material).await?;
    let plan = dream::parse(&raw).ok_or_else(|| anyhow!("dreaming answered without a plan"))?;
    let (kept, rejected) = dream::audit(&snapshot, &messages, plan);
    if !rejected.is_empty() {
        tracing::info!(bot = %bot_id, dropped = rejected.len(), reasons = ?rejected, "dreaming dropped changes");
    }
    let outcome = hub.store.memory_write(|c, now, rev| dream::apply(c, &snapshot, &kept, &messages, now, rev))?;
    match outcome {
        Outcome::Stale => return Ok(Ran::Later),
        Outcome::Changed(dream) => {
            tracing::info!(bot = %bot_id, added = dream.added.len(), archived = dream.archived.len(), "memory dreamed");
            let layer = if kept.add.iter().any(|a| a.shared) { None } else { Some(bot_id) };
            super::changed(hub, layer, Change::Background);
        }
        Outcome::Unchanged => {}
    }
    set_bookmark(&hub.store, bot_id, last_seq)?;
    if review {
        hub.store.kv_set(&reviewed_key(bot_id), &today)?;
    }
    Ok(Ran::Done { more })
}

/// Usage of the bot's harness above [`HEADROOM_PERCENT`] in any window.
fn near_limit(hub: &Hub, cfg: &BotConfig) -> bool {
    hub.usage
        .locked()
        .providers
        .iter()
        .filter(|p| p.id == cfg.backend)
        .flat_map(|p| &p.windows)
        .any(|w| w.percent > HEADROOM_PERCENT)
}

/// The entries up to the [`BATCH`]th user message and the replies after it.
fn within_batch(entries: &[Entry]) -> &[Entry] {
    let mut users = 0;
    for (i, e) in entries.iter().enumerate() {
        if e.kind == EntryKind::User.as_str() {
            if users == BATCH {
                return &entries[..i];
            }
            users += 1;
        }
    }
    entries
}

/// What a run sees of an entry. A user message counts only for what the user typed themselves; one the host wrote
/// in the user's place (`from: host`) isn't the user's words.
fn message(e: &Entry) -> Option<Message> {
    let clip = |text: &str| crate::agent::acp::truncate(text, MESSAGE_CHARS);
    let (from_user, text) = if e.kind == EntryKind::User.as_str() {
        if e.data["from"] == "host" {
            return None;
        }
        (true, super::notices::typed(&e.data).iter().map(|run| clip(run)).collect::<Vec<_>>())
    } else {
        (false, vec![clip(e.data["text"].as_str().unwrap_or_default())])
    };
    let text: Vec<String> = text.into_iter().filter(|run| !run.trim().is_empty()).collect();
    (!text.is_empty()).then(|| Message { id: e.id.clone(), from_user, text, date: super::dates::ymd(e.created_at) })
}

#[cfg(test)]
mod tests {
    use super::dated;

    #[test]
    fn only_dates_trigger_the_time_review() {
        assert!(dated("Going to Singapore in July 2026"));
        assert!(dated("下個月 3號 要搬家"));
        assert!(dated("Dentist on Oct 21"));
        assert!(!dated("Prompt is too long: Provided 10,389 tokens"));
        assert!(!dated("Has 2 cats"));
    }
}
