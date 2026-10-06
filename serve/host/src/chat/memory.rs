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

use crate::LockExt;
use crate::agent::acp::{self, Acp, Incoming};
use crate::hub::Hub;
use crate::store::{BotConfig, Store};
use anyhow::{Context as _, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

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
    fn at(dir: PathBuf) -> Self {
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

fn dedupe_key(content: &str) -> String {
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

fn parse_ymd(s: &str) -> Option<i64> {
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

// MARK: prompt

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

// MARK: extraction (prompts as in Grok Bot)

const TRIVIAL: &[&str] = &[
    "hi",
    "hey",
    "hello",
    "yo",
    "sup",
    "thanks",
    "thank you",
    "ty",
    "thx",
    "ok",
    "okay",
    "k",
    "kk",
    "cool",
    "nice",
    "great",
    "awesome",
    "perfect",
    "yes",
    "yep",
    "yeah",
    "no",
    "nope",
    "sure",
    "got it",
    "gotcha",
    "lol",
    "haha",
    "np",
    "done",
    "good",
    "bye",
];

/// Small talk ("thanks", "ok") isn't worth a keeper run.
pub fn is_memorable(user: &str) -> bool {
    let user = user.trim();
    if user.is_empty() {
        return false;
    }
    if user.chars().count() > 40 || user.contains('?') {
        return true;
    }
    let bare = user.to_lowercase();
    let bare = bare.trim_end_matches(|c: char| c.is_whitespace() || "!.…,~)]".contains(c));
    !TRIVIAL.contains(&bare.split_whitespace().collect::<Vec<_>>().join(" ").as_str())
}

pub fn extraction_system_prompt() -> String {
    [
        "You maintain the long-term memory of a personal assistant. Read the latest exchanges and decide what — if anything — is worth remembering for future, unrelated conversations.",
        "",
        "Tag each fact you keep with a category:",
        "- \"profile\": enduring facts about who the user is and how to work with them — their name and how to address them, role, location, languages, lasting preferences and constraints, and important people or relationships. These are remembered indefinitely.",
        "- \"log\": substantive history worth keeping — ongoing projects and tasks, decisions, commitments, and time-bound details.",
        "- \"note\": minor, low-stakes details that might help someday but are not worth keeping in mind every turn (small one-off preferences, incidental context). Notes fade from the always-visible list fastest but stay on disk.",
        "",
        "Do NOT record one-off request mechanics, what the assistant did this turn, general knowledge, or anything already present in the existing memory list.",
        "",
        "If a new exchange updates or contradicts a fact in the existing memory list (e.g. the user moved, changed jobs, or renamed something), drop anything clearly superseded: output a line \"remove: <the exact existing fact text>\" and then add the corrected fact. Only remove facts that appear verbatim in the existing list — never invent removals.",
        "",
        "Write each fact as a self-contained statement, one per line: \"profile: <fact>\", \"log: <fact>\", or \"note: <fact>\" to add (e.g. \"profile: The user's name is Ian\", \"log: Planning a trip to Tokyo in October 2025\"), or \"remove: <existing fact>\" to drop a superseded one.",
        "Output exactly NONE (and nothing else) when there is nothing to add or remove.",
    ]
    .join("\n")
}

pub fn extraction_user_prompt(turns: &[EpisodeTurn], existing: &[String]) -> String {
    let existing = if existing.is_empty() {
        "(empty)".to_owned()
    } else {
        existing.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n")
    };
    let side = |s: &str| if s.trim().is_empty() { "(no message)".to_owned() } else { s.trim().to_owned() };
    let body = turns
        .iter()
        .map(|t| format!("({})\nUser: {}\nAssistant: {}", ymd(t.ts), side(&t.user), side(&t.agent)))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("Existing memory:\n{existing}\n\nLatest exchanges, oldest first:\n\n{body}")
}

pub fn consolidation_system_prompt() -> String {
    [
        format!("You maintain the long-term memory of a personal assistant. Its profile of the user (enduring facts about who they are and how to work with them) has grown past {PROFILE_PROMPT_LIMIT} facts and must be merged down to at most {PROFILE_TARGET}."),
        "Merge duplicates and near-duplicates into one self-contained statement, drop facts clearly superseded by a newer one (each fact shows the date it was learned), and move anything that is history rather than who the user is (projects, events, one-off details) to the log.".to_owned(),
        "Keep every distinct enduring fact and keep the user's wording where you can. Never invent facts.".to_owned(),
        "Output one fact per line: \"profile: <fact>\" for the new profile, \"log: <fact>\" for what moves to the log. Output nothing else.".to_owned(),
    ]
    .join("\n")
}

pub fn consolidation_user_prompt(facts: &[Fact]) -> String {
    let mut facts: Vec<&Fact> = facts.iter().collect();
    facts.sort_by_key(|f| f.created_at);
    let body = facts.iter().map(|f| format!("- ({}) {}", ymd(f.created_at), f.content)).collect::<Vec<_>>().join("\n");
    format!("Profile, oldest first:\n{body}")
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Extraction {
    pub additions: Vec<(String, Kind)>,
    pub removals: Vec<String>,
}

pub fn parse_extraction(raw: &str, existing: &[String]) -> Extraction {
    let mut out = Extraction::default();
    let raw = raw.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case(NONE) {
        return out;
    }
    let mut seen: HashSet<String> = existing.iter().map(|m| dedupe_key(m)).collect();
    for line in raw.lines() {
        let line = strip_bullet(line);
        let (tag, rest) = match line.split_once(':') {
            Some((t, r)) if ["profile", "log", "note", "remove"].contains(&t.trim().to_lowercase().as_str()) => {
                (Some(t.trim().to_lowercase()), r)
            }
            _ => (None, line),
        };
        let bare = normalize(rest);
        if bare.is_empty() || bare.eq_ignore_ascii_case(NONE) {
            continue;
        }
        if tag.as_deref() == Some("remove") {
            out.removals.push(bare);
            continue;
        }
        let content = if tag.as_deref() == Some("note") { normalize(&format!("{NOTE_PREFIX}{bare}")) } else { bare };
        if seen.insert(dedupe_key(&content)) {
            out.additions.push((content, if tag.as_deref() == Some("profile") { Kind::Profile } else { Kind::Log }));
        }
    }
    out
}

fn strip_bullet(line: &str) -> &str {
    let t = line.trim_start();
    for b in ["- ", "* ", "• "] {
        if let Some(r) = t.strip_prefix(b) {
            return r;
        }
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits > 0
        && let Some(r) = t[digits..].strip_prefix(". ").or_else(|| t[digits..].strip_prefix(") "))
    {
        return r;
    }
    t
}

const STOPWORDS: &[&str] = &[
    "that", "this", "with", "from", "they", "them", "then", "than", "what", "when", "where", "which", "will", "would",
    "could", "should", "have", "been", "being", "about", "just", "like", "your", "does", "were", "also", "into",
    "over", "only", "some", "more", "most", "very", "much", "here", "there", "their", "these", "those", "because",
    "while", "after", "before", "user",
];

fn tokens(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 4 && !STOPWORDS.contains(w))
        .map(str::to_owned)
        .collect()
}

/// What the keeper is shown as "existing memory": everything in the prompt plus
/// archived facts that share words with the exchange.
pub fn existing_for_extraction(mem: &Memory, exchange: &str) -> Vec<String> {
    let recall = mem.recall(RECENT_PROMPT_LIMIT);
    let in_prompt: Vec<&Fact> = recall.profile.iter().chain(&recall.recent).collect();
    let shown: HashSet<String> = in_prompt.iter().map(|f| dedupe_key(&f.content)).collect();
    let query = tokens(exchange);
    let mut relevant: Vec<(usize, Fact)> = if query.is_empty() {
        Vec::new()
    } else {
        mem.list(ARCHIVE_SCAN_LIMIT)
            .into_iter()
            .filter(|f| !shown.contains(&dedupe_key(&f.content)))
            .map(|f| (tokens(&f.content).intersection(&query).count(), f))
            .filter(|(overlap, _)| *overlap > 0)
            .collect()
    };
    relevant.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.created_at.cmp(&a.1.created_at)));
    in_prompt
        .into_iter()
        .map(|f| f.content.clone())
        .chain(relevant.into_iter().take(RELEVANT_LIMIT).map(|(_, f)| f.content))
        .collect()
}

pub fn apply(mem: &Memory, ex: &Extraction, known: &[String], now: i64) -> Result<(usize, usize)> {
    let known: HashSet<String> = known.iter().map(|k| dedupe_key(k)).collect();
    let mut removed = 0;
    for r in &ex.removals {
        if known.contains(&dedupe_key(r)) && mem.remove_by_content(r)? {
            removed += 1;
        }
    }
    let mut added = 0;
    for (content, kind) in &ex.additions {
        if mem.add(content, *kind, now)? {
            added += 1;
        }
    }
    Ok((added, removed))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EpisodeTurn {
    pub ts: i64,
    pub user: String,
    pub agent: String,
}

pub fn episode_system_prompt(bot_name: &str) -> String {
    [
        format!("You maintain the long-term memory of a personal assistant named {bot_name}."),
        format!("You are given the most recent turns of a conversation between the user and {bot_name}, in order, each tagged with its date."),
        format!("Write ONE short journal-style sentence (two at most) capturing what the user and {bot_name} were actually working on across these turns — the throughline, key decisions, and outcomes — so it stays useful months from now."),
        "Anchor any time references with the absolute dates shown, never relative words like \"yesterday\". Drop greetings, acknowledgements, and anything ephemeral. Never invent details.".to_owned(),
        "Output just the sentence(s), no preamble or bullets. Output exactly NONE if nothing in this stretch is worth remembering.".to_owned(),
    ]
    .join("\n")
}

pub fn episode_user_prompt(bot_name: &str, turns: &[EpisodeTurn]) -> String {
    let body = turns
        .iter()
        .map(|t| {
            let mut parts = vec![format!("({})", ymd(t.ts))];
            if !t.user.trim().is_empty() {
                parts.push(format!("User: {}", t.user.trim()));
            }
            if !t.agent.trim().is_empty() {
                parts.push(format!("{bot_name}: {}", t.agent.trim()));
            }
            parts.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("Recent turns, oldest first:\n\n{body}")
}

fn episode_key(bot_id: &str) -> String {
    format!("memory.episode.{bot_id}")
}

pub fn pending_episode(store: &Store, bot_id: &str) -> Vec<EpisodeTurn> {
    store.kv_get(&episode_key(bot_id)).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

pub fn set_pending_episode(store: &Store, bot_id: &str, turns: &[EpisodeTurn]) -> Result<()> {
    store.kv_set(&episode_key(bot_id), &serde_json::to_string(turns)?)
}

// MARK: keeper

/// A finished user ↔ agent exchange worth remembering.
pub struct Exchange {
    pub user: String,
    pub agent: String,
    pub at: i64,
}

fn unprocessed_key(bot_id: &str) -> String {
    format!("memory.unprocessed.{bot_id}")
}

fn unprocessed(store: &Store, bot_id: &str) -> Vec<EpisodeTurn> {
    store.kv_get(&unprocessed_key(bot_id)).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

/// Starts the bot's keeper. Exchanges queue up (persisted, so a restart keeps them)
/// and are remembered together once the bot has been quiet for [`KEEPER_IDLE`] or
/// [`KEEPER_BATCH`] have piled up: the frozen prompt only picks facts up at the next
/// compaction or session anyway, and one run over several exchanges sees their
/// context. An unnamed bot is named right away (see `naming`). It stops when the
/// bot actor drops the sender; what's queued is picked up by the next keeper.
pub fn spawn_keeper(hub: Arc<Hub>, bot_id: String) -> mpsc::UnboundedSender<Exchange> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Exchange>();
    tokio::spawn(async move {
        let mut queued = unprocessed(&hub.store, &bot_id);
        let idle = tokio::time::sleep(KEEPER_IDLE);
        tokio::pin!(idle);
        loop {
            let flush = tokio::select! {
                x = rx.recv() => {
                    let Some(x) = x else { break };
                    let turn = EpisodeTurn {
                        ts: x.at,
                        user: acp::truncate(&x.user, EXCHANGE_CHARS),
                        agent: acp::truncate(&x.agent, EXCHANGE_CHARS),
                    };
                    if let Err(e) = crate::chat::naming::observe(&hub, &bot_id, turn.clone()).await {
                        tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "naming the bot failed");
                    }
                    // Re-read: another keeper of this bot (before a restart) may have flushed.
                    queued = unprocessed(&hub.store, &bot_id);
                    queued.push(turn);
                    if let Err(e) = hub.store.kv_set(&unprocessed_key(&bot_id), &serde_json::to_string(&queued).unwrap_or_default()) {
                        tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "couldn't queue an exchange for memory");
                    }
                    idle.as_mut().reset(tokio::time::Instant::now() + KEEPER_IDLE);
                    queued.len() >= KEEPER_BATCH
                }
                () = &mut idle, if !queued.is_empty() => true,
            };
            if !flush {
                continue;
            }
            let batch = std::mem::take(&mut queued);
            // Cleared before the run: a failing agent must not retry the same batch forever.
            if let Err(e) = hub.store.kv_set(&unprocessed_key(&bot_id), "[]") {
                tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "couldn't clear the memory queue");
            }
            if let Err(e) = remember(&hub, &bot_id, batch).await {
                tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "memory keeper failed");
            }
        }
    });
    tx
}

async fn remember(hub: &Arc<Hub>, bot_id: &str, turns: Vec<EpisodeTurn>) -> Result<()> {
    let Some(cfg) = hub.store.bot(bot_id)?.filter(|b| !b.deleted).map(|b| b.config) else { return Ok(()) };
    let Some(at) = turns.last().map(|t| t.ts) else { return Ok(()) };

    let id = bot_id.to_owned();
    let exchange_text = turns.iter().map(|t| format!("{}\n{}", t.user, t.agent)).collect::<Vec<_>>().join("\n");
    let existing = tokio::task::spawn_blocking(move || {
        Memory::for_bot(&id).map(|mem| existing_for_extraction(&mem, &exchange_text))
    })
    .await??;
    let raw = one_shot(hub, &cfg, &extraction_system_prompt(), &extraction_user_prompt(&turns, &existing)).await?;
    let extraction = parse_extraction(&raw, &existing);
    let id = bot_id.to_owned();
    let (added, removed, crowded) = tokio::task::spawn_blocking(move || {
        Memory::for_bot(&id).and_then(|mem| {
            let (added, removed) = apply(&mem, &extraction, &existing, at)?;
            Ok((added, removed, mem.profile_facts().len() > PROFILE_PROMPT_LIMIT))
        })
    })
    .await??;
    tracing::info!(bot = %bot_id, exchanges = turns.len(), added, removed, "memory updated");
    if crowded && let Err(e) = consolidate(hub, &cfg).await {
        tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "consolidating the profile failed");
    }

    let mut pending = pending_episode(&hub.store, bot_id);
    pending.extend(turns);
    if pending.len() < EPISODE_INTERVAL {
        return set_pending_episode(&hub.store, bot_id, &pending);
    }
    set_pending_episode(&hub.store, bot_id, &[])?;
    let raw = one_shot(hub, &cfg, &episode_system_prompt(&cfg.name), &episode_user_prompt(&cfg.name, &pending)).await?;
    let narrative = normalize(&raw);
    if !narrative.is_empty() && !narrative.eq_ignore_ascii_case(NONE) {
        let at = pending.last().map_or(at, |t| t.ts);
        let id = bot_id.to_owned();
        tokio::task::spawn_blocking(move || {
            Memory::for_bot(&id).and_then(|mem| mem.add(&format!("{EPISODE_PREFIX}{narrative}"), Kind::Log, at))
        })
        .await??;
    }
    Ok(())
}

/// The profile outgrew what the prompt shows: have the keeper merge it down to
/// [`PROFILE_TARGET`] facts. Nothing is lost: facts it drops move to the log.
async fn consolidate(hub: &Arc<Hub>, cfg: &BotConfig) -> Result<()> {
    let id = cfg.id.clone();
    let facts = tokio::task::spawn_blocking(move || Memory::for_bot(&id).map(|m| m.profile_facts())).await??;
    let raw = one_shot(hub, cfg, &consolidation_system_prompt(), &consolidation_user_prompt(&facts)).await?;
    let plan = parse_extraction(&raw, &[]);
    let keep: Vec<&String> = plan.additions.iter().filter(|(_, k)| *k == Kind::Profile).map(|(c, _)| c).collect();
    if keep.is_empty() || keep.len() > PROFILE_PROMPT_LIMIT {
        bail!("the consolidated profile had {} facts", keep.len());
    }
    let now = crate::store::now_ms();
    let dated = |c: &str| facts.iter().find(|f| dedupe_key(&f.content) == dedupe_key(c)).map_or(now, |f| f.created_at);
    let kept: Vec<(String, i64)> = keep.iter().map(|c| ((*c).clone(), dated(c))).collect();
    let kept_keys: HashSet<String> = kept.iter().map(|(c, _)| dedupe_key(c)).collect();
    let mut demoted: Vec<(String, i64)> = facts
        .iter()
        .filter(|f| !kept_keys.contains(&dedupe_key(&f.content)))
        .map(|f| (f.content.clone(), f.created_at))
        .collect();
    demoted.extend(plan.additions.iter().filter(|(_, k)| *k == Kind::Log).map(|(c, _)| (c.clone(), now)));
    let id = cfg.id.clone();
    let (before, after) = (facts.len(), kept.len());
    tokio::task::spawn_blocking(move || Memory::for_bot(&id).and_then(|m| m.rewrite_profile(&kept, &demoted)))
        .await??;
    tracing::info!(bot = %cfg.id, before, after, "profile consolidated");
    Ok(())
}

/// Runs one prompt on a throwaway agent of the bot's harness and returns its reply.
/// Claude gets a real system prompt, no tools, no settings and no saved session;
/// other harnesses get the instructions inline.
pub(crate) async fn one_shot(hub: &Arc<Hub>, cfg: &BotConfig, system: &str, user: &str) -> Result<String> {
    let cwd = crate::service::data_dir().join("memory-keeper");
    tokio::fs::create_dir_all(&cwd).await?;
    let cwd = cwd.to_string_lossy().into_owned();
    if hub.store.kv_read(&format!("agent-env:{}", cfg.backend))?.is_some() {
        crate::market::vault::unlock(hub.clone()).await?;
    }
    let env = crate::agent::auth::env(&hub.store, &cfg.backend)?;
    let mut conn = None;
    let mut last_err = None;
    for command in crate::agent::bot::launch_commands(cfg, |_| {}).await? {
        match crate::agent::bot::start_agent(&command, &cwd, &env, Duration::from_secs(60)).await {
            Ok(c) => {
                conn = Some(c);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let mut conn = conn.ok_or_else(|| last_err.unwrap_or_else(|| anyhow!("no agent to run the memory keeper")))?;
    let acp = conn.acp.clone();
    let result = async {
        let mut params = json!({"cwd": cwd, "mcpServers": []});
        let text = if conn.claude {
            params["_meta"] = json!({
                "systemPrompt": system,
                "claudeCode": {"options": {"tools": [], "persistSession": false, "settingSources": [], "model": "haiku"}},
            });
            user.to_owned()
        } else {
            format!("{system}\n\n---\n\n{user}")
        };
        let res = acp.request("session/new", params).await?;
        let sid = res["sessionId"].as_str().ok_or_else(|| anyhow!("agent returned no sessionId"))?.to_owned();
        // Same model as the bot: the harness default may be another (local) model that
        // would load next to the bot's, or a cloud one the user kept these chats away from.
        if !conn.claude {
            crate::agent::bot::select_model(&acp, &res, &sid, cfg).await?;
        }
        let prompt = acp.request("session/prompt", json!({"sessionId": sid, "prompt": [{"type": "text", "text": text}]}));
        tokio::pin!(prompt);
        let deadline = tokio::time::sleep(KEEPER_TIMEOUT);
        tokio::pin!(deadline);
        let mut out = String::new();
        loop {
            tokio::select! {
                r = &mut prompt => { r?; break }
                inc = conn.rx.recv() => {
                    if !collect(&acp, inc, &mut out).await {
                        bail!("the memory keeper's agent exited");
                    }
                }
                () = &mut deadline => bail!("the memory keeper timed out"),
            }
        }
        while let Ok(inc) = conn.rx.try_recv() {
            collect(&acp, Some(inc), &mut out).await;
        }
        Ok(out)
    }
    .await;
    acp.kill().await;
    result
}

/// Keeps reply text; refuses anything the agent asks of us. False once the agent is gone.
async fn collect(acp: &Acp, inc: Option<Incoming>, out: &mut String) -> bool {
    match inc {
        None | Some(Incoming::Closed { .. }) => false,
        Some(Incoming::Notification { method, params }) => {
            let u = &params["update"];
            if method == "session/update" && u["sessionUpdate"] == "agent_message_chunk" {
                out.push_str(&acp::content_text(&u["content"]));
            }
            true
        }
        Some(Incoming::Request { id, method, .. }) => {
            let _ = if method == "session/request_permission" {
                acp.respond(id, json!({"outcome": {"outcome": "cancelled"}})).await
            } else {
                acp.respond_error(id, -32601, "not supported").await
            };
            true
        }
    }
}

// MARK: history search (the built-in `memory` MCP server)

const SEARCH_DEFAULT: i64 = 10;
const SEARCH_MAX: i64 = 30;
const SEARCH_TERMS: usize = 8;
const SEARCH_TEXT_CHARS: usize = 1_500;

pub const INSTRUCTIONS: &str = "Use search_history to find what was actually said in your past chats with the user \
(their messages and yours, including threads), beyond what your memory notes kept. \
Search for distinctive words; every word must appear. Results are newest first.";

pub fn tools() -> Value {
    json!([{
        "name": "search_history",
        "description": "Search your full chat history with the user for messages containing every given word (case-insensitive). Returns dated messages, newest first.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Words that must all appear, separated by spaces."},
                "limit": {"type": "integer", "description": "Maximum results (default 10, at most 30)."},
            },
            "required": ["query"],
        },
        "annotations": {"readOnlyHint": true},
    }])
}

pub async fn call(hub: &Arc<Hub>, bot_id: &str, name: &str, args: &Value) -> Result<Value> {
    if name != "search_history" {
        bail!("unknown memory tool: {name}");
    }
    let bot = hub.store.bot(bot_id)?.filter(|b| !b.deleted).ok_or_else(|| anyhow!("unknown bot"))?;
    let terms: Vec<String> =
        args["query"].as_str().unwrap_or_default().split_whitespace().take(SEARCH_TERMS).map(str::to_owned).collect();
    if terms.is_empty() {
        bail!("query must contain at least one word");
    }
    let limit = args["limit"].as_i64().unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX);
    let hub = hub.clone();
    let id = bot.config.id.clone();
    let rows = tokio::task::spawn_blocking(move || hub.store.search_messages(&id, &terms, limit)).await??;
    let results: Vec<Value> = rows
        .iter()
        .map(|e| {
            json!({
                "date": ymd(e.created_at),
                "from": if e.kind == crate::store::EntryKind::User.as_str() { "user" } else { "you" },
                "inThread": e.thread_id.is_some(),
                "text": acp::truncate(e.data["text"].as_str().unwrap_or_default(), SEARCH_TEXT_CHARS),
            })
        })
        .collect();
    Ok(json!({"results": results}))
}

/// `memory` API: the facts a bot has, for the Memory screen.
pub fn describe(bot_id: &str) -> Result<Value> {
    let mem = Memory::for_bot(bot_id)?;
    Ok(json!({"location": mem.location(), "facts": mem.list(1_000)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> Memory {
        let dir = std::env::temp_dir().join(format!("codync-memory-{}", uuid::Uuid::new_v4()));
        Memory::at(dir)
    }

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
    fn extraction_output_is_parsed() {
        let existing = vec!["Lives in Taipei".to_owned()];
        let ex = parse_extraction(
            "- profile: The user's name is Ian\n2. log: Planning a trip\nnote: likes tea\nremove: Lives in Taipei\nprofile: lives in taipei\nNONE",
            &existing,
        );
        assert_eq!(
            ex.additions,
            vec![
                ("The user's name is Ian".to_owned(), Kind::Profile),
                ("Planning a trip".to_owned(), Kind::Log),
                ("[note] likes tea".to_owned(), Kind::Log),
            ]
        );
        assert_eq!(ex.removals, vec!["Lives in Taipei".to_owned()]);
        assert_eq!(parse_extraction(" none ", &[]), Extraction::default());
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

    #[test]
    fn batched_exchanges_are_dated_in_order() {
        let t = parse_ymd("2026-09-30").expect("valid date");
        let turns = [
            EpisodeTurn { ts: t, user: "I use Swift 6".into(), agent: "Noted".into() },
            EpisodeTurn { ts: t, user: String::new(), agent: "Done".into() },
        ];
        let prompt = extraction_user_prompt(&turns, &[]);
        assert!(prompt.contains("Existing memory:\n(empty)"));
        assert!(
            prompt.contains("(2026-09-30)\nUser: I use Swift 6\nAssistant: Noted\n\n(2026-09-30)\nUser: (no message)")
        );
    }

    #[test]
    fn small_talk_is_not_memorable() {
        assert!(!is_memorable("thanks!"));
        assert!(!is_memorable("  OK. "));
        assert!(is_memorable("my name is Kai"));
        assert!(is_memorable("why?"));
    }
}
