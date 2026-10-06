//! Opt-in usage analytics: the one-time question, the ^k toggle and `app_opened`.
//! The TUI only talks to the host over its loopback API, so it can always decide for this computer.

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};

use super::{After, App, Overlay};

/// What a key does in the question.
#[derive(Debug, PartialEq, Eq)]
enum Pick {
    /// Share (`true`) or don't.
    Choose(bool),
    /// Highlight this answer (`true` = Share usage).
    Highlight(bool),
    /// Close without answering: asked again next time.
    Later,
}

fn pick(share: bool, code: KeyCode) -> Pick {
    match code {
        KeyCode::Char('y') => Pick::Choose(true),
        KeyCode::Char('n') => Pick::Choose(false),
        KeyCode::Enter => Pick::Choose(share),
        KeyCode::Esc => Pick::Later,
        KeyCode::Left | KeyCode::Char('h') => Pick::Highlight(true),
        KeyCode::Right | KeyCode::Char('l') => Pick::Highlight(false),
        KeyCode::Tab | KeyCode::BackTab => Pick::Highlight(!share),
        _ => Pick::Highlight(share),
    }
}

impl App {
    /// Every `hello`: keep the setting; the first one of this run also reports the launch
    /// and asks once when nobody has decided (a host without analytics has no such key).
    pub(super) fn analytics_hello(&mut self, v: &Value) {
        self.analytics = v["analytics"].as_bool();
        if self.opened {
            return;
        }
        self.opened = true;
        self.call("track", json!({"event": "app_opened"}), After::Tracked);
        if v.get("analytics").is_some_and(Value::is_null) {
            self.overlays.push(Overlay::Consent(true));
        }
    }

    pub(super) fn consent_key(&mut self, share: bool, k: KeyEvent) -> Option<Overlay> {
        match pick(share, k.code) {
            Pick::Choose(on) => {
                self.set_analytics(on);
                None
            }
            Pick::Highlight(share) => Some(Overlay::Consent(share)),
            Pick::Later => None,
        }
    }

    /// ^k → Share usage analytics: flips it, or asks first when it was never decided.
    pub(super) fn toggle_analytics(&mut self) {
        match self.analytics {
            Some(on) => self.set_analytics(!on),
            None => self.overlays.push(Overlay::Consent(true)),
        }
    }

    fn set_analytics(&self, on: bool) {
        self.call("setAnalytics", json!({"enabled": on}), After::Analytics);
    }

    pub(super) fn analytics_set(&mut self, v: &Value) {
        self.analytics = v["enabled"].as_bool();
        self.flash(if self.analytics == Some(true) {
            "Sharing usage analytics"
        } else {
            "Not sharing usage analytics"
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_choose_move_or_close() {
        assert_eq!(pick(true, KeyCode::Char('n')), Pick::Choose(false));
        assert_eq!(pick(false, KeyCode::Char('y')), Pick::Choose(true));
        assert_eq!(pick(false, KeyCode::Enter), Pick::Choose(false));
        assert_eq!(pick(true, KeyCode::Tab), Pick::Highlight(false));
        assert_eq!(pick(true, KeyCode::Right), Pick::Highlight(false));
        assert_eq!(pick(false, KeyCode::Left), Pick::Highlight(true));
        assert_eq!(pick(false, KeyCode::Char('x')), Pick::Highlight(false));
        assert_eq!(pick(true, KeyCode::Esc), Pick::Later);
    }
}
