//! Moving through panes, turns and messages, and answering permission cards.

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};

use super::{After, App, Focus, Msg, TraceMode, Width, copy};

impl App {
    /// `codync-host install` with this same binary, for when nothing is listening yet.
    pub(super) fn install_host(&mut self) {
        let Ok(exe) = std::env::current_exe() else { return };
        self.flash("Installing the host…");
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let out = tokio::process::Command::new(exe).arg("install").output().await;
            let r = match out {
                Ok(o) if o.status.success() => Ok(Value::Null),
                Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_owned()),
                Err(e) => Err(e.to_string()),
            };
            let _ = tx.send(Msg::Reply(After::Installed, r));
        });
    }

    pub(super) fn start_typing(&mut self) {
        if self.selected.is_some() {
            self.typing = true;
            self.chat_page = true;
            self.focus = Focus::Chat;
            if self.trace == TraceMode::Full {
                self.trace = TraceMode::Off;
            }
        }
    }

    pub(super) fn line(&mut self, d: isize) {
        match self.focus {
            Focus::Roster => self.move_bot(d),
            Focus::Chat if self.width == Width::Narrow && !self.chat_page => self.move_bot(d),
            Focus::Chat => self.scroll_chat(-d),
            Focus::Trace => self.scroll_trace(d),
        }
    }

    pub(super) fn scroll_focused(&mut self, up: isize) {
        if self.focus == Focus::Trace {
            self.scroll_trace(-up);
        } else {
            self.scroll_chat(up);
        }
    }

    fn panes(&self) -> Vec<Focus> {
        let mut p = vec![];
        if self.width != Width::Narrow {
            p.push(Focus::Roster);
        }
        if self.trace != TraceMode::Full {
            p.push(Focus::Chat);
        }
        if self.trace != TraceMode::Off {
            p.push(Focus::Trace);
        }
        p
    }

    pub(super) fn cycle_focus(&mut self, back: bool) {
        let p = self.panes();
        let i = p.iter().position(|f| *f == self.focus).unwrap_or(0);
        let n = p.len();
        self.focus = p[if back { (i + n - 1) % n } else { (i + 1) % n }];
    }

    pub(super) fn focus_side(&mut self, d: isize) {
        let p = self.panes();
        let i = p.iter().position(|f| *f == self.focus).unwrap_or(0);
        let j = i.saturating_add_signed(d).min(p.len() - 1);
        self.focus = p[j];
    }

    pub(super) fn step_turn(&mut self, d: isize) {
        let Some(id) = self.selected.clone() else { return };
        let turns = self.lane_turns(&id);
        let Some(&latest) = turns.last() else { return };
        let at = self.trace_turn.and_then(|t| turns.iter().position(|x| *x == t)).unwrap_or(turns.len() - 1);
        let next = turns[at.saturating_add_signed(d).min(turns.len() - 1)];
        self.trace_turn = if next == latest { None } else { Some(next) };
        self.trace_scroll = 0;
        if self.trace == TraceMode::Off {
            self.trace =
                if matches!(self.width, Width::Narrow | Width::Mid) { TraceMode::Full } else { TraceMode::Pane };
        }
    }

    pub(super) fn answer(&mut self, entry: &str, option: &str) {
        // One answer per card: while it is on its way, the card spins and takes no other.
        if self.answering.contains_key(entry) {
            return;
        }
        self.answering.insert(entry.to_owned(), option.to_owned());
        self.call(
            "respondPermission",
            json!({"entryId": entry, "optionId": option}),
            After::Answered(entry.to_owned()),
        );
    }

    pub(super) fn answer_kind(&mut self, key: char) {
        let Some(e) = self.pending() else { return };
        let (entry, opts) = (e.id.clone(), e.options());
        let want: &[&str] = match key {
            'y' => &["allow_once", "allow_always"],
            'a' => &["allow_always", "allow_once"],
            _ => &["reject_once", "reject_always"],
        };
        let pick = want.iter().find_map(|k| opts.iter().find(|(_, _, kind)| kind == k));
        match pick {
            Some((option, _, _)) => {
                let option = option.clone();
                self.answer(&entry, &option);
                if key == 'N' {
                    self.start_typing();
                }
            }
            None => self.flash("That choice isn't offered; use 1–9"),
        }
    }

    /// `r`: moves the pick through the main chat's messages (none picked: the newest).
    pub(super) fn step_pick(&mut self, d: isize) {
        let Some(id) = self.selected.clone() else { return };
        let ids: Vec<String> = self.lane(&id).into_iter().filter(|e| e.is_message()).map(|e| e.id.clone()).collect();
        if ids.is_empty() {
            self.pick = None;
            self.flash("No message to reply to yet");
            return;
        }
        let at = self.pick.as_ref().and_then(|p| ids.iter().position(|x| x == p));
        let i = at.map_or(ids.len() - 1, |i| i.saturating_add_signed(d).min(ids.len() - 1));
        self.pick = Some(ids[i].clone());
    }

    /// Keys while a message is picked. Returns whether the key was used.
    pub(super) fn pick_key(&mut self, k: KeyEvent) -> bool {
        let Some(id) = self.selected.clone() else { return false };
        let picked = self.pick.as_ref().and_then(|p| self.lane(&id).into_iter().find(|e| &e.id == p).cloned());
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.step_pick(1),
            KeyCode::Char('k') | KeyCode::Up => self.step_pick(-1),
            KeyCode::Char('C') => self.open_connection(),
            KeyCode::Enter if picked.as_ref().is_some_and(|e| e.data["connectionRequest"]["status"] == "pending") => {
                self.open_connection();
            }
            KeyCode::Enter | KeyCode::Char('r') if self.thread.is_some() => {
                self.pick = None;
                self.start_typing();
            }
            KeyCode::Enter | KeyCode::Char('r') => {
                if let Some(root) = self.pick.take() {
                    self.open_thread(root);
                    self.start_typing();
                }
            }
            KeyCode::Char(c @ '1'..='6') => {
                if let Some(e) = picked {
                    self.react(&e.id, (c as usize) - ('1' as usize));
                }
            }
            KeyCode::Char('f') => {
                if let Some(e) = picked {
                    self.save_files(&id, &e.data);
                }
            }
            KeyCode::Char('c') => {
                if let Some(e) = picked {
                    copy(e.text());
                    self.flash("Copied");
                }
            }
            KeyCode::Esc => self.pick = None,
            _ => return false,
        }
        true
    }

    pub(super) fn open_thread(&mut self, root: String) {
        let Some(id) = self.selected.clone() else { return };
        self.pick = None;
        self.chat_scroll = 0;
        self.trace_turn = None;
        self.trace_scroll = 0;
        self.chat_page = true;
        self.focus = Focus::Chat;
        if self.trace == TraceMode::Full {
            self.trace = TraceMode::Off;
        }
        self.call("thread", json!({"botId": id, "rootId": root}), After::Thread);
        self.thread = Some(root);
    }

    pub(super) fn copy_last(&mut self) {
        let Some(id) = self.selected.clone() else { return };
        let Some(text) = self.lane(&id).into_iter().rev().find(|e| e.is_final()).map(|e| e.text().to_owned()) else {
            self.flash("No reply to copy");
            return;
        };
        copy(&text);
        self.flash("Copied the last reply");
    }
}
