//! A bot's memory, as in the other apps: what it knows about you (shared by your bots) and on its own, its dream
//! log, and Claude Code's own memory where the user kept it on, driven from the keyboard.

use super::super::app::{App, Confirm, ConfirmAct, Editor, Overlay};
use super::s;
use super::{Page, Reply};
use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Yours,
    Bot,
    /// Both layers' long-form files.
    Notes,
    Dreams,
    /// Claude Code's own memory (its `MEMORY.md`), read-only, where the user kept it on.
    Harness,
}

impl Section {
    const ALL: [Self; 5] = [Self::Yours, Self::Bot, Self::Notes, Self::Dreams, Self::Harness];

    pub fn label(self) -> &'static str {
        match self {
            Self::Yours => "About you",
            Self::Bot => "This bot",
            Self::Notes => "Notes",
            Self::Dreams => "Dreams",
            Self::Harness => "Claude Code",
        }
    }

    /// Whether the section holds memory entries, and of which layer: `Some(true)` the shared one.
    pub fn shared(self) -> Option<bool> {
        match self {
            Self::Yours => Some(true),
            Self::Bot => Some(false),
            Self::Notes | Self::Dreams | Self::Harness => None,
        }
    }
}

pub struct MemorySheet {
    pub bot: String,
    /// The host's `memory` reply.
    pub view: Option<Value>,
    pub section: Section,
    pub cursor: usize,
    pub mode: MemoryMode,
    pub error: Option<String>,
    pub busy: bool,
}

pub enum MemoryMode {
    Browse,
    /// Writing a new entry (`id` none) or changing one.
    Edit {
        id: Option<i64>,
        editor: Editor,
    },
    /// One note: what it holds and its versions (`detail`, once fetched). The cursor moves over the versions.
    File {
        name: String,
        shared: bool,
        detail: Option<Value>,
    },
}

impl MemorySheet {
    pub fn body(&self) -> Value {
        json!({"botId": self.bot})
    }

    pub fn editor(&mut self) -> Option<&mut Editor> {
        match &mut self.mode {
            MemoryMode::Edit { editor, .. } => Some(editor),
            MemoryMode::Browse | MemoryMode::File { .. } => None,
        }
    }

    /// The note sheet's fetch, when one is open.
    pub fn file_body(&self) -> Option<Value> {
        match &self.mode {
            MemoryMode::File { name, shared, .. } => Some(json!({"botId": self.bot, "file": name, "shared": shared})),
            _ => None,
        }
    }

    /// The current section's rows: entries, or dream runs.
    pub fn rows(&self) -> Vec<Value> {
        let Some(view) = &self.view else { return Vec::new() };
        let list = match self.section {
            Section::Yours => &view["yours"]["entries"],
            Section::Bot => &view["bot"]["entries"],
            Section::Dreams => &view["dreams"],
            Section::Notes => {
                // This bot's own first, then the shared ones; each row says which.
                let mut rows = Vec::new();
                for (layer, shared) in [("bot", false), ("yours", true)] {
                    for file in view["files"][layer]["files"].as_array().into_iter().flatten() {
                        let mut file = file.clone();
                        file["shared"] = shared.into();
                        rows.push(file);
                    }
                }
                return rows;
            }
            Section::Harness => return Vec::new(),
        };
        list.as_array().cloned().unwrap_or_default()
    }

    /// Takes a fresh `memory` reply, keeping the cursor on the row it was on: pinning or archiving reorders them.
    pub fn show(&mut self, view: Value) {
        let key = |row: &Value| json!([row["id"], row["name"], row["shared"]]);
        let was = self.rows().get(self.cursor).map(key);
        self.view = Some(view);
        if !self.sections().contains(&self.section) {
            // Claude Code's memory was just turned off; its scroll position means nothing elsewhere.
            self.section = Section::Bot;
            self.cursor = 0;
            return;
        }
        let rows = self.rows();
        self.cursor = was
            .and_then(|k| rows.iter().position(|row| key(row) == k))
            .unwrap_or_else(|| self.cursor.min(rows.len().saturating_sub(1)));
    }

    /// Sections worth showing: Claude Code's memory only when it is kept on.
    pub fn sections(&self) -> Vec<Section> {
        let harness = self.view.as_ref().is_some_and(|v| v["projectMemory"].is_object());
        Section::ALL.into_iter().filter(|s| *s != Section::Harness || harness).collect()
    }

    fn step(&mut self, by: isize) {
        let sections = self.sections();
        let at = sections.iter().position(|s| *s == self.section).unwrap_or(0);
        self.section = sections[at.saturating_add_signed(by).min(sections.len() - 1)];
        self.cursor = 0;
    }
}

impl App {
    pub fn open_memory(&mut self) {
        let Some(bot) = self.bot().filter(|b| !b.group).map(|b| b.id.clone()) else {
            self.flash("A group has no memory of its own");
            return;
        };
        let m = MemorySheet {
            bot: bot.clone(),
            view: None,
            section: Section::Bot,
            cursor: 0,
            mode: MemoryMode::Browse,
            error: None,
            busy: true,
        };
        self.sheet("memory", m.body(), Reply::Memory(bot));
        self.overlays.push(Overlay::Memory(m));
    }

    /// The name of the bot's harness as the agent list gives it ("Claude Code").
    pub fn harness_name(&self, bot: &str) -> String {
        let Some(backend) = self.bots.get(bot).map(|b| b.backend.as_str()) else { return String::new() };
        self.backends.iter().find(|b| b["id"] == backend).map_or_else(|| backend.to_owned(), |b| s(b, "name"))
    }

    /// A bot's memory changed somewhere (its `memoryRev` moved): an open sheet fetches it again.
    pub(in crate::tui) fn memory_moved(&mut self, bot: &Value) {
        let mut stale = Vec::new();
        for o in &self.overlays {
            if let Overlay::Memory(m) = o
                && bot["id"] == m.bot.as_str()
                && m.view.as_ref().is_some_and(|v| v["memoryRev"] != bot["memoryRev"])
            {
                stale.push(m.bot.clone());
            }
        }
        for id in stale {
            self.sheet("memory", json!({"botId": id}), Reply::Memory(id.clone()));
        }
    }

    pub(in crate::tui) fn memory_key(&mut self, mut m: MemorySheet, k: KeyEvent) -> Option<Overlay> {
        if let MemoryMode::File { .. } = m.mode {
            return self.note_key(m, k);
        }
        if let MemoryMode::Edit { id, editor } = &mut m.mode {
            match k.code {
                KeyCode::Esc => m.mode = MemoryMode::Browse,
                KeyCode::Enter if !m.busy && !editor.text.trim().is_empty() => {
                    m.busy = true;
                    let body = json!({"botId": m.bot, "id": id, "shared": m.section == Section::Yours, "text": editor.text.trim()});
                    self.sheet("saveMemory", body, Reply::MemorySaved(m.bot.clone()));
                }
                _ => {
                    editor.key(k);
                }
            }
            return Some(Overlay::Memory(m));
        }
        if let Some(page) = Page::Memory.step(k) {
            self.open_page(page);
            return None;
        }
        let rows = m.rows();
        let selected = rows.get(m.cursor).cloned();
        let entry = selected.as_ref().filter(|_| m.section.shared().is_some());
        match k.code {
            KeyCode::Esc | KeyCode::Char('q' | 'M') => return None,
            KeyCode::Tab | KeyCode::Right | KeyCode::Char('l') => self.step_section(&mut m, 1),
            KeyCode::BackTab | KeyCode::Left | KeyCode::Char('h') => self.step_section(&mut m, -1),
            KeyCode::Down | KeyCode::Char('j') => {
                // Claude Code's memory scrolls by line; the other sections move between rows.
                let last = if m.section == Section::Harness {
                    m.view
                        .as_ref()
                        .map_or(0, |v| v["projectMemory"]["text"].as_str().unwrap_or_default().lines().count())
                } else {
                    rows.len()
                };
                m.cursor = (m.cursor + 1).min(last.saturating_sub(1));
            }
            KeyCode::Up | KeyCode::Char('k') => m.cursor = m.cursor.saturating_sub(1),
            KeyCode::Char('r') => {
                m.busy = true;
                self.sheet("memory", m.body(), Reply::Memory(m.bot.clone()));
            }
            KeyCode::Char('n') if m.section.shared().is_some() => {
                m.mode = MemoryMode::Edit { id: None, editor: Editor::default() };
            }
            KeyCode::Char('n') if m.section == Section::Notes => {
                let fields = super::memory_file_fields(&m.bot, false, None, None, NOTE_TEMPLATE);
                self.overlays.push(Overlay::Memory(m));
                self.overlays.push(Overlay::Fields(Box::new(fields)));
                return None;
            }
            KeyCode::Enter | KeyCode::Char('e') if m.section == Section::Notes && selected.is_some() => {
                let file = selected.expect("checked above");
                m.mode = MemoryMode::File { name: s(&file, "name"), shared: file["shared"] == true, detail: None };
                m.cursor = 0;
                if let Some(body) = m.file_body() {
                    self.sheet("memoryFile", body, Reply::MemoryFile(m.bot.clone()));
                }
            }
            KeyCode::Enter | KeyCode::Char('e') if entry.is_some() => {
                let e = entry.expect("checked above");
                m.mode = MemoryMode::Edit {
                    id: e["id"].as_i64(),
                    editor: Editor::with(e["text"].as_str().unwrap_or_default()),
                };
            }
            KeyCode::Char('p' | 'a' | 'x') if entry.is_some() && !m.busy => {
                let e = entry.expect("checked above");
                let (method, body) = match k.code {
                    KeyCode::Char('p') => {
                        ("pinMemory", json!({"botId": m.bot, "id": e["id"], "pinned": e["pinned"] != true}))
                    }
                    KeyCode::Char('a') => {
                        ("archiveMemory", json!({"botId": m.bot, "id": e["id"], "archived": e["state"] != "archived"}))
                    }
                    _ => ("forgetMemory", json!({"botId": m.bot, "id": e["id"]})),
                };
                m.busy = true;
                self.sheet(method, body, Reply::MemorySaved(m.bot.clone()));
            }
            KeyCode::Char('u') if m.section == Section::Dreams && !m.busy => {
                if let Some(dream) = selected.filter(|d| d["undone"] != true) {
                    m.busy = true;
                    self.sheet(
                        "undoDream",
                        json!({"botId": m.bot, "id": dream["id"]}),
                        Reply::MemorySaved(m.bot.clone()),
                    );
                }
            }
            KeyCode::Char('s') if !m.busy => {
                let shared = m.view.as_ref().is_some_and(|v| v["shared"] == true);
                m.busy = true;
                self.sheet(
                    "updateBot",
                    json!({"id": m.bot, "sharedMemory": !shared}),
                    Reply::MemorySaved(m.bot.clone()),
                );
            }
            KeyCode::Char('m') if !m.busy => return self.harness_memory_key(m),
            KeyCode::Char('D') if !rows.is_empty() && !m.busy => {
                if let Some(shared) = m.section.shared() {
                    let c = Confirm {
                        title: if shared {
                            "Forget everything shared about you?"
                        } else {
                            "Forget everything this bot remembers?"
                        }
                        .into(),
                        detail: if shared {
                            "Every bot loses these memories."
                        } else {
                            "This bot's own memories are removed."
                        }
                        .into(),
                        note: "The chat stays.".into(),
                        button: "Forget everything",
                        act: ConfirmAct::ClearMemory(m.bot.clone(), shared),
                    };
                    self.overlays.push(Overlay::Memory(m));
                    self.overlays.push(Overlay::Confirm(c));
                    return None;
                }
            }
            _ => {}
        }
        Some(Overlay::Memory(m))
    }

    /// Moves to another section. Claude Code writes its notes outside Codync, so nothing moves `memoryRev`: its
    /// section reads them again on the way in.
    fn step_section(&mut self, m: &mut MemorySheet, by: isize) {
        m.step(by);
        if m.section == Section::Harness {
            m.busy = true;
            self.sheet("memory", m.body(), Reply::Memory(m.bot.clone()));
        }
    }

    /// `m`: turns the harness's own memory off, or asks first, saying what it costs, before turning it on.
    fn harness_memory_key(&mut self, mut m: MemorySheet) -> Option<Overlay> {
        match self.bots.get(&m.bot).and_then(|b| b.harness_memory) {
            Some(true) => {
                m.busy = true;
                self.sheet(
                    "updateBot",
                    json!({"id": m.bot, "harnessMemory": false}),
                    Reply::MemorySaved(m.bot.clone()),
                );
            }
            Some(false) => {
                // One line each in the confirmation: the info sheets' points, short.
                let c = Confirm {
                    title: format!("Turn on {}'s own memory?", self.harness_name(&m.bot)),
                    detail: "It may store things twice; the two memories can disagree.".into(),
                    note: "Forgetting something in Codync doesn't reach it.".into(),
                    button: "Turn on",
                    act: ConfirmAct::KeepHarnessMemory(m.bot.clone()),
                };
                self.overlays.push(Overlay::Memory(m));
                self.overlays.push(Overlay::Confirm(c));
                return None;
            }
            None => {}
        }
        Some(Overlay::Memory(m))
    }

    /// Keys on a note: read it, edit it, delete it, or bring back a version.
    fn note_key(&mut self, mut m: MemorySheet, k: KeyEvent) -> Option<Overlay> {
        let MemoryMode::File { name, shared, detail } = &m.mode else { return Some(Overlay::Memory(m)) };
        let (name, shared) = (name.clone(), *shared);
        let content = detail.as_ref().and_then(|d| d["content"].as_str()).map(str::to_owned);
        let base = detail.as_ref().and_then(|d| d["hash"].as_str()).map(str::to_owned);
        let versions = detail.as_ref().and_then(|d| d["versions"].as_array()).cloned().unwrap_or_default();
        match k.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                m.mode = MemoryMode::Browse;
                m.cursor = 0;
            }
            KeyCode::Down | KeyCode::Char('j') => m.cursor = (m.cursor + 1).min(versions.len().saturating_sub(1)),
            KeyCode::Up | KeyCode::Char('k') => m.cursor = m.cursor.saturating_sub(1),
            KeyCode::Char('e') if content.is_some() => {
                let fields = super::memory_file_fields(
                    &m.bot,
                    shared,
                    Some(&name),
                    base,
                    content.as_deref().unwrap_or_default(),
                );
                self.overlays.push(Overlay::Memory(m));
                self.overlays.push(Overlay::Fields(Box::new(fields)));
                return None;
            }
            KeyCode::Char('x') if content.is_some() && !m.busy => {
                let c = Confirm {
                    title: format!("Delete {name}?"),
                    detail: "The bot no longer sees it.".into(),
                    note: "Its versions stay, so you can bring it back.".into(),
                    button: "Delete",
                    act: ConfirmAct::DeleteMemoryFile { bot: m.bot.clone(), shared, name, base },
                };
                self.overlays.push(Overlay::Memory(m));
                self.overlays.push(Overlay::Confirm(c));
                return None;
            }
            KeyCode::Enter | KeyCode::Char('r') if !m.busy => {
                if let Some(version) = versions
                    .get(m.cursor)
                    .filter(|v| v["content"].is_string() && v["content"].as_str() != content.as_deref())
                {
                    m.busy = true;
                    let body =
                        json!({"botId": m.bot, "file": name, "shared": shared, "version": version["id"], "base": base});
                    self.sheet("restoreMemoryFile", body, Reply::MemorySaved(m.bot.clone()));
                }
            }
            _ => {}
        }
        Some(Overlay::Memory(m))
    }
}

/// What a new note starts with.
const NOTE_TEMPLATE: &str = "---\ndescription: When to read this note\n---\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_follows_its_entry_when_pinning_reorders_them() {
        let view = |ids: [i64; 3]| json!({"bot": {"entries": ids.map(|id| json!({"id": id}))}});
        let mut m = MemorySheet {
            bot: "b".into(),
            view: Some(view([1, 2, 3])),
            section: Section::Bot,
            cursor: 2,
            mode: MemoryMode::Browse,
            error: None,
            busy: false,
        };
        m.show(view([3, 1, 2]));
        assert_eq!(m.cursor, 0, "entry 3 was pinned to the top");
        m.show(view([1, 2, 4]));
        assert_eq!(m.cursor, 0, "gone: the cursor stays in range");
    }

    #[test]
    fn turning_claude_codes_memory_off_leaves_its_section() {
        let entries = json!({"entries": [{"id": 1}, {"id": 2}]});
        let mut m = MemorySheet {
            bot: "b".into(),
            view: Some(json!({"bot": entries, "projectMemory": {"path": "p", "text": "a\nb\nc\nd"}})),
            section: Section::Harness,
            cursor: 3,
            mode: MemoryMode::Browse,
            error: None,
            busy: false,
        };
        m.show(json!({"bot": entries, "projectMemory": null}));
        assert_eq!((m.section, m.cursor), (Section::Bot, 0), "its scroll position isn't a row");
    }
}
