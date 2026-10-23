//! Dreaming over the agents' files: kith-mem's dream (entries, quotes from the user's words, an audit) mapped onto
//! the Markdown an hq agent keeps.
//!
//! What the model sees as entries are the bullet lines of the agent's `memory/MEMORY.md` and of the shared
//! `user.md`, numbered 1.. for the run. A line is the dream's own when it is under a `## From conversations`
//! heading and a run logged writing it (the agent also appends to the end of MEMORY.md, which may be that
//! section); only those can be archived, rewritten or moved out. Every other line is shown as the user's. The agent's other
//! top-level notes (`memory/*.md`) are the "long-form files": listed with their descriptions, appended to, never
//! rewritten. Every file goes through [`super::write`] as `Who::Dream`, so the same checks, forgotten facts and
//! versions apply as to any write, and a refused file is dropped whole.
//!
//! Each run is a row of `memory_dreams` (keyed by the agent) with the versions it wrote in `memory_dream_files`
//! and its line changes in `hq_dream_changes`; [`undo`] puts the files back.

use super::{Layout, Target, Who, now_ms, put, read, record_undo, sync, write};
use anyhow::{Result, anyhow, bail};
use kith_mem::dream::{self, Plan, Snapshot};
use kith_mem::files::{self, File, Version};
use kith_mem::rusqlite::{Connection, params};
use kith_mem::store::{self, Author, Entry, State};
use kith_mem::tokens;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The heading a dream's own lines live under, in `MEMORY.md` (read every session) and in `user.md`.
pub const SECTION: &str = "From conversations";
/// The most lines one run shows the model; the dream's own come first.
const MAX_LINES: usize = 200;
/// The most notes listed as long-form files.
const MAX_NOTES: usize = 30;
/// Characters of one line the model sees.
const LINE_CHARS: usize = 400;
/// `MEMORY.md` is "full" at nine-tenths of the lines hqmem warns at, `user.md` of its token budget: the model may
/// then move lines out to notes.
const FULL_LINES: usize = 135;
const FULL_USER_TOKENS: usize = 360;
const MEMORY: &str = "MEMORY.md";
const USER: &str = "user.md";

/// Creates the table of a run's line changes. Idempotent; [`super::open_with`] calls it.
pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS hq_dream_changes (
            dream INTEGER NOT NULL,
            kind TEXT NOT NULL,
            file TEXT NOT NULL,
            shared INTEGER NOT NULL,
            text TEXT NOT NULL,
            was TEXT
        );
        CREATE INDEX IF NOT EXISTS hq_dream_changes_dream ON hq_dream_changes (dream);",
    )?;
    Ok(())
}

/// The agent's folder: the first of the layout's agents folders that holds one by its name.
pub fn agent_dir(layout: &Layout, agent: &str) -> Option<PathBuf> {
    if agent.is_empty() || agent.starts_with('.') || agent.contains(['/', '\\']) {
        return None;
    }
    layout.agents.iter().map(|root| root.join(agent)).find(|dir| dir.is_dir())
}

/// A memory file of the agent (`shared`: false) or of the shared user layer, `None` when the layout has no such
/// agent or the name isn't a memory file.
pub fn target_of(layout: &Layout, agent: &str, shared: bool, name: &str) -> Option<Target> {
    let path = if shared { layout.state.join(name) } else { agent_dir(layout, agent)?.join("memory").join(name) };
    layout.locate(&path, Path::new("/")).filter(|t| t.bot.is_none() == shared && t.name == name)
}

struct Loaded {
    target: Target,
    /// What the run saw: `None` when there was no file.
    content: Option<String>,
}

/// A numbered line the model sees.
struct Line {
    /// Its whole text (the model sees it clipped).
    full: String,
    file: usize,
    /// Its index among the file's lines.
    index: usize,
    dream: bool,
}

/// The memory of one agent as a run sees it.
pub struct Material {
    pub snapshot: Snapshot,
    agent: String,
    layout: Layout,
    /// `[0]` the agent's MEMORY.md, `[1]` user.md, then its notes.
    loaded: Vec<Loaded>,
    /// Line `n` is `lines[n - 1]`.
    lines: Vec<Line>,
}

struct Bullet {
    index: usize,
    text: String,
    dream: bool,
}

fn heading(trimmed: &str) -> Option<&str> {
    trimmed.starts_with('#').then(|| trimmed.trim_start_matches('#').trim())
}

fn marker(trimmed: &str) -> Option<&str> {
    trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "))
}

/// The bullet lines of a file outside its frontmatter, and whether each is under the dream's heading.
fn bullets(content: &str) -> Vec<Bullet> {
    let (mut front, mut dream, mut out) = (false, false, Vec::new());
    for (index, raw) in content.lines().enumerate() {
        let t = raw.trim();
        if index == 0 && t == "---" {
            front = true;
            continue;
        }
        if front {
            front = t != "---";
            continue;
        }
        if let Some(h) = heading(t) {
            dream = h == SECTION;
        } else if let Some(text) = marker(t).map(str::trim).filter(|t| !t.is_empty()) {
            out.push(Bullet { index, text: text.to_owned(), dream });
        }
    }
    out
}

fn clip(text: &str) -> String {
    if text.chars().count() <= LINE_CHARS { text.to_owned() } else { text.chars().take(LINE_CHARS).collect() }
}

/// The lines (as [`norm`] reads them) that the agent's runs wrote and are still in effect: what the dream may change.
pub fn written(conn: &Connection, agent: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT c.text FROM hq_dream_changes c JOIN memory_dreams d ON d.id = c.dream
         WHERE d.bot = ?1 AND d.undone = 0 AND c.kind IN ('added', 'indexed', 'reviewed')",
    )?;
    let texts = stmt.query_map([agent], |row| row.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(texts.iter().map(|t| norm(t)).collect())
}

/// Reads the agent's memory and the shared one. `None` when the agent has no folder here. `written` is what
/// [`written`] says; without it every line under the dream's heading counts as the dream's.
pub fn load(layout: &Layout, agent: &str, today: &str, written: Option<&HashSet<String>>) -> Result<Option<Material>> {
    let Some(dir) = agent_dir(layout, agent) else { return Ok(None) };
    let wanted = |shared: bool, name: &str| {
        target_of(layout, agent, shared, name).ok_or_else(|| anyhow!("{name} is not a memory file here"))
    };
    let mut loaded = Vec::new();
    for (shared, name) in [(false, MEMORY), (true, USER)] {
        let target = wanted(shared, name)?;
        loaded.push(Loaded { content: read(&target.path), target });
    }
    // The agent's other top-level notes, for the model to append to.
    let mut notes: Vec<String> = std::fs::read_dir(dir.join("memory"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| super::is_markdown(n) && n != MEMORY && !n.starts_with('.'))
        .collect();
    notes.sort();
    notes.truncate(MAX_NOTES);
    let mut listed = Vec::new();
    for name in notes {
        let Some(target) = target_of(layout, agent, false, &name) else { continue };
        let content = read(&target.path);
        listed.push(File {
            bot: Some(agent.to_owned()),
            hash: content.as_deref().map(files::hash).unwrap_or_default(),
            size: content.as_deref().map_or(0, |c| c.len() as u64),
            mtime: 0,
            description: content.as_deref().and_then(files::description),
            tokens: content.as_deref().map_or(0, tokens::estimate),
            deleted: false,
            version: 0,
            updated_at: 0,
            rev: 0,
            name,
        });
        loaded.push(Loaded { target, content });
    }

    let mut all: Vec<(usize, Bullet)> = Vec::new();
    for (file, l) in loaded.iter().take(2).enumerate() {
        let lines = bullets(l.content.as_deref().unwrap_or_default());
        all.extend(lines.into_iter().map(|mut b| {
            b.dream &= written.is_none_or(|w| w.contains(&norm(&b.text)));
            (file, b)
        }));
    }
    if all.len() > MAX_LINES {
        let mut room = MAX_LINES.saturating_sub(all.iter().filter(|(_, b)| b.dream).count());
        all.retain(|(_, b)| {
            b.dream || {
                let keep = room > 0;
                room = room.saturating_sub(1);
                keep
            }
        });
    }
    let (mut entries, mut lines) = (Vec::new(), Vec::new());
    for (n, (file, b)) in all.into_iter().enumerate() {
        entries.push(Entry {
            id: i64::try_from(n + 1)?,
            bot: (file == 0).then(|| agent.to_owned()),
            state: State::Active,
            text: clip(&b.text),
            author: if b.dream { Author::Dream } else { Author::User },
            author_bot: b.dream.then(|| agent.to_owned()),
            pinned: false,
            superseded_by: None,
            room: None,
            evidence: Vec::new(),
            created_at: 0,
            updated_at: 0,
            rev: 0,
        });
        lines.push(Line { full: b.text, file, index: b.index, dream: b.dream });
    }
    let full = loaded[0].content.as_deref().is_some_and(|c| c.lines().count() >= FULL_LINES)
        || loaded[1].content.as_deref().is_some_and(|c| tokens::estimate(c) >= FULL_USER_TOKENS);
    let snapshot = Snapshot::from_parts(agent, true, entries, listed, full, today);
    Ok(Some(Material { snapshot, agent: agent.to_owned(), layout: layout.clone(), loaded, lines }))
}

impl Material {
    /// The texts of the lines the dream wrote itself (what the time review may rewrite).
    pub fn dream_lines(&self) -> impl Iterator<Item = &str> {
        self.snapshot.entries.iter().zip(&self.lines).filter(|(_, l)| l.dream).map(|(e, _)| e.text.as_str())
    }
}

/// A file's lines while a run edits it.
struct Doc {
    lines: Vec<String>,
    remove: BTreeSet<usize>,
    replace: HashMap<usize, String>,
}

impl Doc {
    fn new(content: Option<&str>) -> Self {
        Self {
            lines: content.unwrap_or_default().lines().map(str::to_owned).collect(),
            remove: BTreeSet::new(),
            replace: HashMap::new(),
        }
    }

    /// Applies the marked removals and rewrites. The indices of those marks are the file's own, so this comes
    /// before any append.
    fn settle(&mut self) {
        for (index, text) in std::mem::take(&mut self.replace) {
            let line = &self.lines[index];
            let lead: String = line.chars().take_while(|c| c.is_whitespace()).collect();
            let bullet = if line.trim_start().starts_with('*') { "*" } else { "-" };
            self.lines[index] = format!("{lead}{bullet} {text}");
        }
        for index in std::mem::take(&mut self.remove).into_iter().rev() {
            self.lines.remove(index);
        }
    }

    fn has(&self, text: &str) -> bool {
        let wanted = norm(text);
        self.lines.iter().any(|l| marker(l.trim()).is_some_and(|t| norm(t) == wanted))
    }

    fn mentions(&self, name: &str) -> bool {
        self.lines.iter().any(|l| l.contains(name))
    }

    /// Adds a bullet at the end of the dream's section, which a file without one gets.
    fn add(&mut self, text: &str, title: &str) {
        let line = format!("- {}", one_line(text));
        if self.lines.iter().all(|l| l.trim().is_empty()) {
            self.lines = vec![format!("# {title}"), String::new()];
        }
        if let Some(h) = self.lines.iter().position(|l| heading(l.trim()) == Some(SECTION)) {
            let end = (h + 1..self.lines.len()).find(|&i| heading(self.lines[i].trim()).is_some());
            let end = end.unwrap_or(self.lines.len());
            let at = (h + 1..end).rev().find(|&i| !self.lines[i].trim().is_empty()).map_or(h + 1, |i| i + 1);
            self.lines.insert(at, line);
        } else {
            if self.lines.last().is_some_and(|l| !l.trim().is_empty()) {
                self.lines.push(String::new());
            }
            self.lines.push(format!("## {SECTION}"));
            self.lines.push(line);
        }
    }

    /// A bullet at the end of the file (a note's line).
    fn push(&mut self, text: &str) {
        self.lines.push(format!("- {}", one_line(text)));
    }

    fn text(&self) -> String {
        let mut out = self.lines.join("\n");
        out.push('\n');
        out
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A line compared with another: case, spacing and end punctuation aside.
fn norm(text: &str) -> String {
    one_line(text).to_lowercase().trim_end_matches(['.', '。', '!', '！']).to_owned()
}

/// A line for a note: its text, where it goes, and the line of MEMORY.md or user.md it was moved from.
struct Note {
    file: String,
    text: String,
    description: String,
    from: Option<usize>,
}

/// What a run wrote.
#[derive(Debug, Default)]
pub struct Applied {
    /// The logged run; `None` when nothing was written.
    pub dream: Option<i64>,
    /// Memory changed during the run: nothing was written.
    pub stale: bool,
    pub versions: Vec<Version>,
    /// Changes dropped, with why: a refused file, a shared note.
    pub dropped: Vec<String>,
}

/// Writes an audited plan as one logged run of the agent. `Applied::stale` when a file the run read has changed.
pub fn apply(conn: &Connection, m: &Material, plan: &Plan) -> Result<Applied> {
    let mut out = Applied::default();
    if plan.is_empty() {
        return Ok(out);
    }
    if m.loaded.iter().any(|l| read(&l.target.path) != l.content) {
        out.stale = true;
        return Ok(out);
    }
    let line = |id: i64| usize::try_from(id).ok().and_then(|n| n.checked_sub(1)).and_then(|i| m.lines.get(i));
    let entry = |id: i64| m.snapshot.entries.iter().find(|e| e.id == id);

    // The notes first: a line only leaves MEMORY.md once the note that now holds it is written.
    let mut notes: Vec<Note> = Vec::new();
    for a in &plan.append {
        notes.push(Note { file: a.file.clone(), text: a.text.clone(), description: a.description.clone(), from: None });
    }
    for mv in &plan.move_out {
        match (line(mv.id), entry(mv.id)) {
            (Some(l), Some(_)) if l.file == 0 => notes.push(Note {
                file: mv.file.clone(),
                text: l.full.clone(),
                description: mv.description.clone(),
                from: Some(usize::try_from(mv.id - 1)?),
            }),
            _ => out.dropped.push(format!("move [{}]: only the agent's own lines move to notes", mv.id)),
        }
    }
    // The run is logged once a file is written, so a run that wrote nothing leaves no undoable row.
    let run = std::cell::Cell::new(None::<i64>);
    let ensure_run = || -> Result<i64> {
        if let Some(id) = run.get() {
            return Ok(id);
        }
        conn.execute("INSERT INTO memory_dreams (bot, at) VALUES (?1, ?2)", params![m.agent, now_ms()])?;
        run.set(Some(conn.last_insert_rowid()));
        Ok(conn.last_insert_rowid())
    };
    let log = |kind: &str, target: &Target, text: &str, was: Option<&str>| -> Result<()> {
        conn.execute(
            "INSERT INTO hq_dream_changes (dream, kind, file, shared, text, was) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ensure_run()?, kind, target.name, target.bot.is_none(), text, was],
        )?;
        Ok(())
    };
    let put_file = |out: &mut Applied, target: &Target, before: Option<&str>, after: &str| -> Result<bool> {
        if before == Some(after) {
            return Ok(false);
        }
        match write(conn, target, Who::Dream(&m.agent), after)? {
            Ok(written) => {
                if let Some(v) = written.version {
                    conn.execute(
                        "INSERT INTO memory_dream_files (dream, version) VALUES (?1, ?2)",
                        params![ensure_run()?, v.id],
                    )?;
                    out.versions.push(v);
                }
                Ok(true)
            }
            Err(refusal) => {
                out.dropped.push(format!("{}: {}", target.label(), refusal.message()));
                Ok(false)
            }
        }
    };

    let mut by_file: BTreeMap<&str, Vec<&Note>> = BTreeMap::new();
    for note in &notes {
        by_file.entry(note.file.as_str()).or_default().push(note);
    }
    let mut written_notes: HashSet<String> = HashSet::new();
    for (file, group) in by_file {
        let Some(target) = target_of(&m.layout, &m.agent, false, file) else {
            out.dropped.push(format!("{file}: not a memory file of {}", m.agent));
            continue;
        };
        let before = m
            .loaded
            .iter()
            .find(|l| l.target.bot.is_some() && l.target.name == file)
            .map_or_else(|| read(&target.path), |l| l.content.clone());
        let mut doc = Doc::new(before.as_deref());
        if before.as_deref().is_none_or(|c| c.trim().is_empty()) {
            let description = group.iter().map(|n| n.description.trim()).find(|d| !d.is_empty()).unwrap_or(file);
            doc.lines = vec!["---".into(), format!("description: {}", one_line(description)), "---".into()];
        }
        let mut added = Vec::new();
        for note in group {
            if !doc.has(&note.text) {
                doc.push(&note.text);
                added.push(note.text.trim().to_owned());
            }
        }
        let wrote = put_file(&mut out, &target, before.as_deref(), &doc.text())?;
        // The note holds the lines now: this run wrote them, or the file had them already.
        if wrote || added.is_empty() {
            written_notes.insert(file.to_owned());
        }
        if wrote {
            for text in &added {
                log("noted", &target, text, None)?;
            }
        }
    }

    // The agent's MEMORY.md and the shared user.md.
    let (mut memory, mut user) = (Doc::new(m.loaded[0].content.as_deref()), Doc::new(m.loaded[1].content.as_deref()));
    let mut changes: [Vec<(&str, String, Option<String>)>; 2] = [Vec::new(), Vec::new()];
    let mut marks = |file: usize,
                     index: usize,
                     new: Option<&str>,
                     changes: &mut [Vec<(&'static str, String, Option<String>)>; 2],
                     kind: &'static str,
                     text: String,
                     was: Option<String>| {
        let doc = if file == 0 { &mut memory } else { &mut user };
        match new {
            Some(new) => {
                doc.replace.insert(index, one_line(new));
            }
            None => {
                doc.remove.insert(index);
            }
        }
        changes[file].push((kind, text, was));
    };
    for a in &plan.archive {
        if let (Some(l), Some(e)) = (line(a.id), entry(a.id))
            && l.dream
        {
            marks(l.file, l.index, None, &mut changes, "archived", e.text.clone(), None);
        }
    }
    for r in &plan.review {
        if let (Some(l), Some(e)) = (line(r.id), entry(r.id))
            && l.dream
        {
            marks(l.file, l.index, Some(&r.text), &mut changes, "reviewed", one_line(&r.text), Some(e.text.clone()));
        }
    }
    for note in notes.iter().filter(|n| written_notes.contains(&n.file)) {
        if let Some(from) = note.from {
            marks(0, m.lines[from].index, None, &mut changes, "archived", note.text.clone(), None);
        }
    }
    memory.settle();
    user.settle();
    for add in &plan.add {
        let (doc, title, file) = if add.shared { (&mut user, "About the user", 1) } else { (&mut memory, "Memory", 0) };
        if doc.has(&add.text) {
            out.dropped.push(format!("add \"{}\": already in the file", add.text));
        } else {
            doc.add(&add.text, title);
            changes[file].push(("added", add.text.trim().to_owned(), None));
        }
    }
    let mut indexed: HashSet<&str> = HashSet::new();
    for note in notes.iter().filter(|n| written_notes.contains(&n.file)) {
        if !memory.mentions(&note.file) && indexed.insert(&note.file) {
            let description = m
                .snapshot
                .files
                .iter()
                .find(|f| f.name == note.file)
                .and_then(|f| f.description.clone())
                .or_else(|| Some(note.description.trim().to_owned()).filter(|d| !d.is_empty()))
                .unwrap_or_else(|| note.file.clone());
            let line = format!("[{0}]({0}) — {description}", note.file);
            memory.add(&line, "Memory");
            changes[0].push(("indexed", line, None));
        }
    }
    for (file, doc, changes) in [(0, &memory, &changes[0]), (1, &user, &changes[1])] {
        let l = &m.loaded[file];
        if !changes.is_empty() && put_file(&mut out, &l.target, l.content.as_deref(), &doc.text())? {
            for (kind, text, was) in changes {
                log(kind, &l.target, text, was.as_deref())?;
            }
        }
    }
    out.dream = run.get();
    Ok(out)
}

/// The agent's latest runs, newest first, as the apps show them.
pub fn runs(conn: &Connection, agent: &str, limit: usize) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for run in dream::recent(conn, agent, limit)? {
        let mut stmt =
            conn.prepare("SELECT kind, file, shared, text, was FROM hq_dream_changes WHERE dream = ?1 ORDER BY rowid")?;
        let changes: Vec<Value> = stmt
            .query_map([run.id], |row| {
                Ok(json!({
                    "kind": row.get::<_, String>(0)?, "file": row.get::<_, String>(1)?,
                    "shared": row.get::<_, bool>(2)?, "text": row.get::<_, String>(3)?, "was": row.get::<_, Option<String>>(4)?,
                }))
            })?
            .collect::<std::result::Result<_, _>>()?;
        out.push(json!({"id": run.id, "at": run.at, "undone": run.undone, "files": run.files, "changes": changes}));
    }
    Ok(out)
}

/// What an undo did.
#[derive(Debug, Default)]
pub struct Report {
    pub restored: Vec<String>,
    /// Files left as they are, with why.
    pub refused: Vec<(String, String)>,
    /// Every file is back (the run is marked undone).
    pub undone: bool,
}

/// Puts back the files a run wrote. A file that changed after the run (the agent's turn, the user, a later run) is
/// left as it is and named with the reason; the run counts as undone once all of its files are back.
pub fn undo(conn: &Connection, layout: &Layout, agent: &str, id: i64) -> Result<Report> {
    let run = dream::get(conn, id)?.filter(|d| d.bot == agent).ok_or_else(|| anyhow!("unknown dream"))?;
    let mut out = Report { undone: run.undone, ..Report::default() };
    let mut back: Vec<(String, bool)> = Vec::new();
    if run.undone {
        return Ok(out);
    }
    for file in &run.files {
        let label = if file.shared { file.name.clone() } else { format!("{agent}/{}", file.name) };
        let Some(target) = target_of(layout, agent, file.shared, &file.name) else {
            out.refused.push((label, "the file is no longer here".into()));
            continue;
        };
        // An edit made since the run, outside the hook, becomes a version before we compare.
        sync(conn, &target)?;
        let versions = files::versions(conn, target.bot.as_deref(), &target.name, usize::MAX)?;
        let Some(at) = versions.iter().position(|v| v.id == file.version) else {
            out.refused.push((label, "its history no longer holds this version".into()));
            continue;
        };
        let before = versions.get(at + 1).and_then(|v| v.content.clone());
        let now = read(&target.path);
        if now == before {
            // Already back, by hand or by an earlier undo.
            back.push((file.name.clone(), file.shared));
            out.restored.push(label);
            continue;
        }
        if at != 0 {
            let newest = &versions[0];
            let who = match newest.author {
                files::Author::User => "you".to_owned(),
                files::Author::Bot => newest.author_bot.clone().unwrap_or_else(|| "the agent".into()),
                files::Author::Dream => "a later dream".into(),
                files::Author::Computer => "something outside kith".into(),
            };
            out.refused.push((label, format!("changed after the dream (by {who}); restore a version by hand")));
            continue;
        }
        put(&target.path, before.as_deref())?;
        record_undo(conn, &target, Who::Kai)?;
        back.push((file.name.clone(), file.shared));
        out.restored.push(label);
    }
    // What the run added is not learned again.
    let added: Vec<(String, String, bool)> = {
        let mut stmt = conn.prepare(
            "SELECT text, file, shared FROM hq_dream_changes WHERE dream = ?1 AND kind IN ('added', 'noted')",
        )?;
        stmt.query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?
    };
    for (text, file, shared) in added {
        if back.contains(&(file, shared)) {
            store::forbid(conn, (!shared).then_some(agent), &text, None)?;
        }
    }
    out.undone = out.refused.is_empty();
    if out.undone {
        conn.execute("UPDATE memory_dreams SET undone = 1 WHERE id = ?1", [id])?;
    }
    if out.restored.is_empty() && !out.refused.is_empty() {
        let why: Vec<String> = out.refused.iter().map(|(f, r)| format!("{f}: {r}")).collect();
        bail!("can't undo this dream. {}", why.join("; "));
    }
    Ok(out)
}
