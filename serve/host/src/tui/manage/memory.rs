//! A bot's memory sheet.

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::json;

use super::super::app::{App, Confirm, ConfirmAct, Overlay};
use super::{MemorySheet, Reply};

impl App {
    pub fn open_memory(&mut self) {
        let Some(b) = self.bot().filter(|b| !b.group) else {
            self.flash("A group has no memory of its own");
            return;
        };
        let bot = b.id.clone();
        self.sheet("memory", json!({"botId": bot}), Reply::Memory(bot.clone()));
        self.overlays.push(Overlay::Memory(MemorySheet { bot, facts: None, cursor: 0 }));
    }

    pub(in crate::tui) fn memory_key(&mut self, mut m: MemorySheet, k: KeyEvent) -> Option<Overlay> {
        let n = m.facts.as_ref().map_or(0, Vec::len);
        match k.code {
            KeyCode::Esc | KeyCode::Char('q' | 'M') => return None,
            KeyCode::Down | KeyCode::Char('j') => m.cursor = (m.cursor + 1).min(n.saturating_sub(1)),
            KeyCode::Up | KeyCode::Char('k') => m.cursor = m.cursor.saturating_sub(1),
            KeyCode::Char('x' | 'd') | KeyCode::Delete | KeyCode::Backspace => {
                if let Some(f) = m.facts.as_mut().filter(|f| m.cursor < f.len()) {
                    let fact = f.remove(m.cursor);
                    m.cursor = m.cursor.min(f.len().saturating_sub(1));
                    self.sheet("forgetMemory", json!({"botId": m.bot, "id": fact.id}), Reply::Changed);
                }
            }
            KeyCode::Char('D') if n > 0 => {
                let name = self.bots.get(&m.bot).map_or_else(String::new, |b| b.name.clone());
                let c = Confirm {
                    title: format!("Forget everything {name} remembers?"),
                    detail: "Facts about you and its history go away.".into(),
                    note: "The chat stays.".into(),
                    button: "Forget everything",
                    act: ConfirmAct::ClearMemory(m.bot.clone()),
                };
                self.overlays.push(Overlay::Memory(m));
                self.overlays.push(Overlay::Confirm(c));
                return None;
            }
            _ => {}
        }
        Some(Overlay::Memory(m))
    }
}
