//! A one-time move of the memory Codync kept before (an Engram database per bot, and the Markdown files before
//! that) into the host's memory tables. Each bot moves once; then the old files go.
//!
//! What the old opening showed comes in active, as far as the bot's cap allows: the profile and pinned facts
//! first, then the newest. The rest is archived, still searchable. Dreaming changes moved entries only on the
//! user's own contrary words.

use crate::hub::Hub;
use crate::store::Store;
use anyhow::{Context, Result};
use codync_mem::store::{self as mem, Error, New, Writer};
use std::path::Path;

/// Prefix the old keeper put on notes.
const NOTE_PREFIX: &str = "[note] ";

struct Fact {
    text: String,
    /// About the user (the old profile) rather than a log entry.
    profile: bool,
    pinned: bool,
    /// Unix milliseconds.
    at: i64,
}

/// Moves every bot's old memory once, then removes what the old memory left on disk. Errors are logged per bot,
/// and the bot keeps its old files until a later start moves them.
pub fn import_old_memory(hub: &Hub) {
    let data = crate::service::data_dir();
    let rows = match hub.store.bots() {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = format!("{error:#}"), "couldn't list bots to move their memory");
            return;
        }
    };
    let mut kept = std::collections::HashSet::new();
    for row in rows.iter().filter(|r| !r.deleted && !r.config.is_group()) {
        let id = &row.config.id;
        if let Err(error) = import_bot(&hub.store, id, &data.join("bots").join(id)) {
            tracing::warn!(bot = %id, error = format!("{error:#}"), "couldn't move the bot's old memory");
            kept.insert(id.clone());
        }
    }
    // Every bot folder, deleted bots' too, loses what the old memory left there.
    for dir in std::fs::read_dir(data.join("bots")).into_iter().flatten().flatten() {
        if !kept.contains(&*dir.file_name().to_string_lossy()) {
            for old in ["engram", "memory"] {
                remove(&dir.path().join(old));
            }
        }
    }
    if hub.store.kv_get("memory.moved").is_none() {
        // The old keeper's queues and session bindings, and its notices' revisions (uuids, not revs).
        for prefix in
            ["memory.unprocessed.", "memory.episode.", "memory.session.", "memory.revision.", "memory.announced."]
        {
            for key in hub.store.kv_prefix(prefix) {
                let _ = hub.store.kv_delete(&key);
            }
        }
        for row in rows.iter().filter(|r| !r.deleted && !r.config.is_group()) {
            if let Err(error) = crate::chat::context::invalidate(&hub.store, &row.config.id) {
                tracing::warn!(bot = %row.config.id, error = format!("{error:#}"), "couldn't re-render instructions");
            }
        }
        let _ = hub.store.kv_set("memory.moved", "1");
    }
    for old in ["engram", "memory-keeper"] {
        remove(&data.join(old));
    }
}

fn import_bot(store: &Store, bot: &str, dir: &Path) -> Result<()> {
    let marker = format!("memory.imported.{bot}");
    if store.kv_get(&marker).is_some() {
        return Ok(());
    }
    let engram = dir.join("engram/engram.db");
    let facts = if engram.exists() { read_engram(&engram)? } else { read_markdown(&dir.join("memory"))? };
    let count = facts.len();
    store.memory_write(|c, _, rev| {
        let mut used = 0;
        for fact in &facts {
            let new = New { bot: Some(bot), text: &fact.text, room: None, evidence: &[] };
            let entry = match mem::add(c, Writer::Import, new, fact.at, rev) {
                Ok(entry) => entry,
                Err(Error::Refused(_)) => continue,
                Err(e) => return Err(e),
            };
            if fact.pinned {
                mem::pin(c, entry.id, true, fact.at, rev)?;
            }
            let size = codync_mem::tokens::estimate(&entry.text);
            if used + size <= codync_mem::tokens::BOT_CAP {
                used += size;
            } else {
                mem::archive(c, Writer::Import, entry.id, None, fact.at, rev)?;
            }
        }
        Ok(())
    })?;
    // Dreaming starts from now: what came before is in the moved memory already.
    super::dream::set_bookmark(store, bot, store.last_seq(bot))?;
    store.kv_set(&marker, &count.to_string())?;
    tracing::info!(bot, facts = count, "moved the bot's old memory");
    Ok(())
}

/// The old Engram observations, profile and pinned first, newest first: the order the opening takes them in.
fn read_engram(path: &Path) -> Result<Vec<Fact>> {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("opening the old memory database")?;
    let mut stmt = db.prepare(
        "SELECT content, scope, pinned, created_at FROM observations
         WHERE deleted_at IS NULL AND type NOT LIKE '%summary%'
         ORDER BY pinned DESC, (scope = 'personal') DESC, created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, bool>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut facts = Vec::new();
    for row in rows {
        let (content, scope, pinned, created) = row?;
        let text = content.strip_prefix(NOTE_PREFIX).unwrap_or(&content).trim().to_owned();
        if text.is_empty() {
            continue;
        }
        let at = chrono::NaiveDateTime::parse_from_str(&created, "%Y-%m-%d %H:%M:%S%.f")
            .map_or_else(|_| crate::store::now_ms(), |t| t.and_utc().timestamp_millis());
        facts.push(Fact { text, profile: scope.as_deref() == Some("personal") || pinned, pinned, at });
    }
    Ok(facts)
}

/// The Markdown memory from before Engram: `profile.md` about the user, `log/*.md` dated notes, as bullets
/// `- (YYYY-MM-DD) fact`.
fn read_markdown(dir: &Path) -> Result<Vec<Fact>> {
    let mut files = Vec::new();
    match std::fs::read_to_string(dir.join("profile.md")) {
        Ok(text) => files.push((true, text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("reading profile memory"),
    }
    match std::fs::read_dir(dir.join("log")) {
        Ok(entries) => {
            for entry in entries {
                let path = entry?.path();
                if path.extension().is_some_and(|x| x == "md") {
                    files.push((false, std::fs::read_to_string(&path)?));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("reading memory logs"),
    }
    let mut facts: Vec<Fact> =
        files.iter().flat_map(|(profile, text)| text.lines().filter_map(move |line| bullet(line, *profile))).collect();
    facts.sort_by_key(|f| (!f.profile, std::cmp::Reverse(f.at)));
    Ok(facts)
}

fn bullet(line: &str, profile: bool) -> Option<Fact> {
    let rest = line.trim().strip_prefix("- ")?;
    let (at, text) = rest
        .strip_prefix('(')
        .and_then(|r| r.split_once(')'))
        .and_then(|(date, text)| {
            let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
            Some((day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis(), text))
        })
        .unwrap_or((crate::store::now_ms(), rest));
    let text = text.trim();
    (!text.is_empty()).then(|| Fact { text: text.to_owned(), profile, pinned: false, at })
}

fn remove(path: &Path) {
    match std::fs::remove_dir_all(path) {
        Ok(()) => tracing::info!(path = %path.display(), "removed the old memory files"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!(path = %path.display(), error = %e, "couldn't remove the old memory files"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_bullets_keep_their_dates() {
        let fact = bullet("- (2026-03-01) Prefers tea", true).unwrap();
        assert_eq!(fact.text, "Prefers tea");
        assert_eq!(super::super::dates::ymd(fact.at), "2026-03-01");
        assert_eq!(bullet("- undated fact", false).unwrap().text, "undated fact");
        assert!(bullet("plain line", true).is_none());
    }
}
