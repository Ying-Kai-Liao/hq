//! A bot's memory, as in the other apps: what it knows about you (shared by your bots) and on its own, its dream
//! log, and its project folder's own memory, driven from the keyboard.

use super::super::app::{App, Confirm, ConfirmAct, Editor, Overlay};
use super::Reply;
use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Yours,
    Bot,
    Dreams,
    /// The project folder's own memory (Claude Code's `MEMORY.md`), read-only.
    Project,
}

impl Section {
    const ALL: [Self; 4] = [Self::Yours, Self::Bot, Self::Dreams, Self::Project];

    pub fn label(self) -> &'static str {
        match self {
            Self::Yours => "About you",
            Self::Bot => "This bot",
            Self::Dreams => "Dreams",
            Self::Project => "Project memory",
        }
    }

    /// Whether the section holds memory entries, and of which layer: `Some(true)` the shared one.
    pub fn shared(self) -> Option<bool> {
        match self {
            Self::Yours => Some(true),
            Self::Bot => Some(false),
            Self::Dreams | Self::Project => None,
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
}

impl MemorySheet {
    pub fn body(&self) -> Value {
        json!({"botId": self.bot})
    }

    pub fn editor(&mut self) -> Option<&mut Editor> {
        match &mut self.mode {
            MemoryMode::Edit { editor, .. } => Some(editor),
            MemoryMode::Browse => None,
        }
    }

    /// The current section's rows: entries, or dream runs.
    pub fn rows(&self) -> Vec<Value> {
        let Some(view) = &self.view else { return Vec::new() };
        let list = match self.section {
            Section::Yours => &view["yours"]["entries"],
            Section::Bot => &view["bot"]["entries"],
            Section::Dreams => &view["dreams"],
            Section::Project => return Vec::new(),
        };
        list.as_array().cloned().unwrap_or_default()
    }

    /// Sections worth showing: project memory only when the folder has one.
    pub fn sections(&self) -> Vec<Section> {
        let project = self.view.as_ref().is_some_and(|v| v["projectMemory"].is_object());
        Section::ALL.into_iter().filter(|s| *s != Section::Project || project).collect()
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
        let rows = m.rows();
        let selected = rows.get(m.cursor).cloned();
        let entry = selected.as_ref().filter(|_| m.section.shared().is_some());
        match k.code {
            KeyCode::Esc | KeyCode::Char('q' | 'M') => return None,
            KeyCode::Tab | KeyCode::Right | KeyCode::Char('l') => m.step(1),
            KeyCode::BackTab | KeyCode::Left | KeyCode::Char('h') => m.step(-1),
            KeyCode::Down | KeyCode::Char('j') => {
                // Project memory scrolls by line; the other sections move between rows.
                let last = if m.section == Section::Project {
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
}
