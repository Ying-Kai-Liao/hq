//! The memory folder on disk: profile and dated log facts, read, added, removed and rewritten.

use super::{DAY_MS, LOG_DIR, LOG_HEADER, MAX_FACT_CHARS, PROFILE_FILE, PROFILE_HEADER, PROFILE_PROMPT_LIMIT, WRITES};
use crate::LockExt;
use anyhow::{Context as _, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Who the user is and how to work with them; kept indefinitely.
    Profile,
    /// Dated history: projects, decisions, commitments, episodes, notes.
    Log,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub content: String,
    pub created_at: i64,
    pub kind: Kind,
    #[serde(skip)]
    path: PathBuf,
    #[serde(skip)]
    line: usize,
    #[serde(skip)]
    order: usize,
}

pub struct Recall {
    pub profile: Vec<Fact>,
    pub recent: Vec<Fact>,
}

/// One bot's memory folder.
pub struct Memory {
    dir: PathBuf,
}

impl Memory {
    pub fn for_bot(bot_id: &str) -> Result<Self> {
        // Bot ids are host-generated UUIDs; anything else must not become a path.
        if bot_id.is_empty() || !bot_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            bail!("invalid bot id");
        }
        Ok(Self { dir: crate::service::data_dir().join("bots").join(bot_id).join("memory") })
    }

    #[cfg(test)]
    pub(super) fn at(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn location(&self) -> &Path {
        &self.dir
    }

    fn profile_path(&self) -> PathBuf {
        self.dir.join(PROFILE_FILE)
    }

    fn log_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(self.dir.join(LOG_DIR))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "md"))
            .collect();
        paths.sort();
        paths
    }

    pub fn facts(&self) -> Vec<Fact> {
        let mut facts = parse_facts(&read(&self.profile_path()), Kind::Profile, &self.profile_path(), 0);
        for path in self.log_paths() {
            let base = facts.len();
            facts.extend(parse_facts(&read(&path), Kind::Log, &path, base));
        }
        facts
    }

    /// Newest first: every profile fact (capped) and the latest log facts.
    pub fn recall(&self, recent_limit: usize) -> Recall {
        let mut facts = self.facts();
        facts.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.order.cmp(&a.order)));
        let (profile, recent): (Vec<Fact>, Vec<Fact>) = facts.into_iter().partition(|f| f.kind == Kind::Profile);
        Recall {
            profile: profile.into_iter().take(PROFILE_PROMPT_LIMIT).collect(),
            recent: recent.into_iter().take(recent_limit).collect(),
        }
    }

    /// Profile facts first, then newest.
    pub fn list(&self, limit: usize) -> Vec<Fact> {
        let mut facts = self.facts();
        facts.sort_by(|a, b| {
            (b.kind == Kind::Profile)
                .cmp(&(a.kind == Kind::Profile))
                .then(b.created_at.cmp(&a.created_at))
                .then(b.order.cmp(&a.order))
        });
        facts.truncate(limit);
        facts
    }

    pub fn profile_facts(&self) -> Vec<Fact> {
        parse_facts(&read(&self.profile_path()), Kind::Profile, &self.profile_path(), 0)
    }

    fn log_path(&self, at_ms: i64) -> PathBuf {
        self.dir.join(LOG_DIR).join(format!("{}.md", &ymd(at_ms)[..7]))
    }

    /// Replaces the profile with `keep`, moving `demote` to the log first (a crash
    /// in between leaves a duplicate, never a lost fact).
    pub fn rewrite_profile(&self, keep: &[(String, i64)], demote: &[(String, i64)]) -> Result<()> {
        let _g = WRITES.locked();
        for (content, at) in demote {
            append(&self.log_path(*at), LOG_HEADER, &normalize(content), *at)?;
        }
        let mut body = PROFILE_HEADER.to_owned();
        for (content, at) in keep {
            let _ = writeln!(body, "- ({}) {}", ymd(*at), normalize(content));
        }
        write_atomic(&self.profile_path(), &body)
    }

    /// Records a fact unless an equal one exists. Returns whether it was added.
    pub fn add(&self, content: &str, kind: Kind, at_ms: i64) -> Result<bool> {
        let content = normalize(content);
        if content.is_empty() {
            return Ok(false);
        }
        let _g = WRITES.locked();
        if self.facts().iter().any(|f| dedupe_key(&f.content) == dedupe_key(&content)) {
            return Ok(false);
        }
        let (path, header) = match kind {
            Kind::Profile => (self.profile_path(), PROFILE_HEADER),
            Kind::Log => (self.log_path(at_ms), LOG_HEADER),
        };
        append(&path, header, &content, at_ms)?;
        Ok(true)
    }

    pub fn remove(&self, id: &str) -> Result<bool> {
        let _g = WRITES.locked();
        let Some(fact) = self.facts().into_iter().find(|f| f.id == id) else { return Ok(false) };
        let mut lines: Vec<&str> = Vec::new();
        let raw = read(&fact.path);
        lines.extend(raw.split('\n'));
        if fact.line < lines.len() {
            lines.remove(fact.line);
        }
        write_atomic(&fact.path, &lines.join("\n"))?;
        Ok(true)
    }

    pub fn remove_by_content(&self, content: &str) -> Result<bool> {
        self.remove(&fact_id(&normalize(content)))
    }

    pub fn clear(&self) -> Result<()> {
        let _g = WRITES.locked();
        match std::fs::remove_dir_all(self.dir.join(LOG_DIR)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        write_atomic(&self.profile_path(), PROFILE_HEADER)
    }
}

fn append(path: &Path, header: &str, content: &str, at_ms: i64) -> Result<()> {
    let raw = read(path);
    let mut body = if raw.is_empty() { header.to_owned() } else { raw };
    if !body.ends_with('\n') {
        body.push('\n');
    }
    let _ = writeln!(body, "- ({}) {content}", ymd(at_ms));
    write_atomic(path, &body)
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn write_atomic(path: &Path, body: &str) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("memory path has no folder"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

fn parse_facts(raw: &str, kind: Kind, path: &Path, base: usize) -> Vec<Fact> {
    let mut out = Vec::new();
    for (line, text) in raw.split('\n').enumerate() {
        let Some(rest) = text.trim_end().strip_prefix("- (") else { continue };
        let Some((date, content)) = rest.split_once(") ") else { continue };
        let Some(created_at) = parse_ymd(date) else { continue };
        let content = normalize(content);
        if content.is_empty() {
            continue;
        }
        out.push(Fact {
            id: fact_id(&content),
            content,
            created_at,
            kind,
            path: path.to_owned(),
            line,
            order: base + out.len(),
        });
    }
    out
}

pub fn normalize(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_FACT_CHARS).collect()
}

pub(super) fn dedupe_key(content: &str) -> String {
    normalize(content).to_lowercase()
}

/// Stable id of a fact (FNV-1a of its dedupe key), so the same text is the same fact.
fn fact_id(content: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in dedupe_key(content).bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

// MARK: dates (UTC, no calendar crate needed)

/// `YYYY-MM-DD` for a unix time in ms.
pub fn ymd(ms: i64) -> String {
    if ms <= 0 {
        return "unknown date".into();
    }
    let z = ms.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

pub(super) fn parse_ymd(s: &str) -> Option<i64> {
    let mut parts = s.splitn(3, '-').map(str::parse::<i64>);
    let (y, m, d) = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * DAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::memory::tests::temp;
    use crate::chat::memory::{RECENT_PROMPT_LIMIT, render};

    #[test]
    fn dates_round_trip() {
        assert_eq!(ymd(0), "unknown date");
        assert_eq!(ymd(1_758_800_000_000), "2025-09-25");
        assert_eq!(ymd(951_782_400_000), "2000-02-29");
        for day in ["2024-02-29", "2026-01-01", "1999-12-31"] {
            assert_eq!(ymd(parse_ymd(day).expect("valid date")), day);
        }
        assert_eq!(parse_ymd("2026-13-01"), None);
    }

    #[test]
    fn facts_are_stored_deduped_and_removed() {
        let mem = temp();
        let t = parse_ymd("2026-09-25").expect("valid date");
        assert!(mem.add("The user's name is Kai", Kind::Profile, t).expect("add"));
        assert!(!mem.add("the user's   name is kai", Kind::Profile, t).expect("add"));
        assert!(mem.add("Shipping Codync 2.2", Kind::Log, t).expect("add"));
        assert!(read(&mem.dir.join("log/2026-09.md")).contains("- (2026-09-25) Shipping Codync 2.2"));
        let recall = mem.recall(RECENT_PROMPT_LIMIT);
        assert_eq!(recall.profile.len(), 1);
        assert_eq!(recall.recent.len(), 1);
        let (text, has) = render(&recall, mem.location());
        assert!(has && text.contains("- (learned 2026-09-25) The user's name is Kai"));
        assert!(mem.remove_by_content("Shipping Codync 2.2").expect("remove"));
        assert!(mem.recall(10).recent.is_empty());
        mem.clear().expect("clear");
        assert!(mem.facts().is_empty());
        let _ = std::fs::remove_dir_all(&mem.dir);
    }

    #[test]
    fn consolidation_moves_dropped_facts_to_the_log() {
        let mem = temp();
        let t = parse_ymd("2026-08-01").expect("valid date");
        for fact in ["Name is Kai", "Is called Kai", "Lives in Taipei"] {
            assert!(mem.add(fact, Kind::Profile, t).expect("add"));
        }
        let now = parse_ymd("2026-09-30").expect("valid date");
        mem.rewrite_profile(
            &[("The user's name is Kai".into(), now), ("Lives in Taipei".into(), t)],
            &[("Name is Kai".into(), t), ("Is called Kai".into(), t)],
        )
        .expect("rewrite");
        let profile: Vec<String> = mem.profile_facts().into_iter().map(|f| f.content).collect();
        assert_eq!(profile, ["The user's name is Kai", "Lives in Taipei"]);
        let log = read(&mem.dir.join("log/2026-08.md"));
        assert!(log.contains("- (2026-08-01) Name is Kai") && log.contains("- (2026-08-01) Is called Kai"));
        let _ = std::fs::remove_dir_all(&mem.dir);
    }
}
