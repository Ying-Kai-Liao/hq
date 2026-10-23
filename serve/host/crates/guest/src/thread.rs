//! What a bot sees of a conversation (section 5.8, `BotEntry`) and how a turn's reply is assembled from it. Entries come
//! from two places, the events subscription and `botThread` catch-ups, and are keyed by `id`: an entry that grows is
//! replaced in place, and nothing is ever counted twice.

use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct BotEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub turn: Option<u64>,
    /// `user | agent | notice | waiting`
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, rename = "final")]
    pub is_final: bool,
    #[serde(default)]
    pub error: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Thread {
    pub entries: Vec<BotEntry>,
    pub done: bool,
    /// `running | queued | idle | waitingApproval | stopped`
    pub state: String,
}

pub fn parse_thread(v: &Value) -> Thread {
    let entries = v["entries"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| serde_json::from_value(e.clone()).ok()).collect())
        .unwrap_or_default();
    Thread {
        entries,
        done: v["done"].as_bool().unwrap_or(false),
        state: v["state"].as_str().unwrap_or_default().to_string(),
    }
}

/// The entry inside an `entry` event, if that is what the event is. The conversation filter is the caller's.
pub fn entry_of_event(ev: &Value) -> Option<(Option<String>, BotEntry)> {
    if ev["type"] != "entry" {
        return None;
    }
    let body = if ev["entry"].is_object() { &ev["entry"] } else { ev };
    let entry: BotEntry = serde_json::from_value(body.clone()).ok()?;
    let conversation = ev["conversation"].as_str().or_else(|| body["conversation"].as_str()).map(str::to_string);
    Some((conversation, entry))
}

/// One asked turn's answer, as far as it has arrived.
#[derive(Debug)]
pub struct Reply {
    pub turn: u64,
    agents: Vec<BotEntry>,
    pub waiting: Option<String>,
    waiting_seq: u64,
    pub failed: Option<String>,
    pub last_seq: u64,
}

impl Reply {
    pub fn new(turn: u64, since: u64) -> Self {
        Self { turn, agents: vec![], waiting: None, waiting_seq: 0, failed: None, last_seq: since }
    }

    /// Returns true when the entry changed what we know.
    pub fn apply(&mut self, e: &BotEntry) -> bool {
        self.last_seq = self.last_seq.max(e.seq);
        match e.kind.as_str() {
            "agent" if e.turn.is_none_or(|t| t == self.turn) => {
                if self.waiting.is_some() && e.seq > self.waiting_seq {
                    self.waiting = None;
                }
                if let Some(old) = self.agents.iter_mut().find(|a| a.id == e.id) {
                    if old == e {
                        return false;
                    }
                    *old = e.clone();
                } else {
                    self.agents.push(e.clone());
                    self.agents.sort_by_key(|a| a.seq);
                }
                true
            }
            "waiting" if e.turn == Some(self.turn) => {
                let changed = self.waiting.as_deref() != Some(e.text.as_str());
                self.waiting = Some(e.text.clone());
                self.waiting_seq = e.seq;
                changed
            }
            // A notice that ends the turn badly keeps its text (the thread's own origin line has no turn and never ends it).
            "notice" if e.turn == Some(self.turn) && (e.is_final || e.error) => {
                let changed = self.failed.as_deref() != Some(e.text.as_str());
                self.failed = Some(e.text.clone());
                changed
            }
            _ => false,
        }
    }

    /// The reply so far: the turn's agent entries, in order.
    pub fn text(&self) -> String {
        self.agents.iter().map(|a| a.text.trim_end()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n")
    }

    pub fn has_final(&self) -> bool {
        self.agents.iter().any(|a| a.is_final)
    }
}

/// How much of `now` to print after `printed` was already printed: the new suffix when the text only grew.
/// `None` when the text was rewritten, which a terminal can't take back; the caller prints it once at the end.
pub fn suffix<'a>(printed: &str, now: &'a str) -> Option<&'a str> {
    now.strip_prefix(printed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, seq: u64, turn: u64, kind: &str, text: &str, fin: bool) -> BotEntry {
        BotEntry {
            id: id.into(),
            seq,
            turn: Some(turn),
            kind: kind.into(),
            text: text.into(),
            is_final: fin,
            error: false,
        }
    }

    #[test]
    fn an_entry_that_grows_is_replaced_not_repeated() {
        let mut r = Reply::new(7, 10);
        assert!(r.apply(&entry("a1", 11, 7, "agent", "The list", false)));
        assert!(r.apply(&entry("a1", 11, 7, "agent", "The list has milk", false)));
        assert!(!r.apply(&entry("a1", 11, 7, "agent", "The list has milk", false)), "same entry again changes nothing");
        assert_eq!(r.text(), "The list has milk");
        assert!(!r.has_final());
        assert!(r.apply(&entry("a1", 11, 7, "agent", "The list has milk.", true)));
        assert!(r.has_final());
    }

    #[test]
    fn other_turns_and_user_entries_are_ignored() {
        let mut r = Reply::new(7, 0);
        assert!(!r.apply(&entry("a0", 3, 6, "agent", "old answer", true)));
        assert!(!r.apply(&entry("u1", 4, 7, "user", "question", true)));
        assert_eq!(r.text(), "");
        assert_eq!(r.last_seq, 4);
    }

    #[test]
    fn two_agent_entries_of_a_turn_are_joined_in_seq_order() {
        let mut r = Reply::new(2, 0);
        r.apply(&entry("b", 6, 2, "agent", "second", true));
        r.apply(&entry("a", 5, 2, "agent", "first", false));
        assert_eq!(r.text(), "first\n\nsecond");
    }

    #[test]
    fn waiting_is_open_until_the_agent_goes_on() {
        let mut r = Reply::new(2, 0);
        assert!(r.apply(&entry("w", 5, 2, "waiting", "Waiting for Sam to approve a step", false)));
        assert_eq!(r.waiting.as_deref(), Some("Waiting for Sam to approve a step"));
        assert!(!r.apply(&entry("w", 5, 2, "waiting", "Waiting for Sam to approve a step", false)), "told once");
        r.apply(&entry("a", 6, 2, "agent", "done", true));
        assert_eq!(r.waiting, None);
    }

    #[test]
    fn only_a_final_notice_of_this_turn_fails_it() {
        let mut r = Reply::new(2, 0);
        let mut origin = entry("n0", 1, 2, "notice", "from Grok", false);
        origin.turn = None;
        assert!(!r.apply(&origin));
        assert_eq!(r.failed, None);
        assert!(r.apply(&entry("n1", 9, 2, "notice", "The agent crashed", true)));
        assert_eq!(r.failed.as_deref(), Some("The agent crashed"));
    }

    #[test]
    fn events_parse_both_shapes() {
        let nested = json!({"type": "entry", "conversation": "cv_1", "entry": {"id": "x", "seq": 4, "turn": 1, "kind": "agent", "text": "hi", "final": true}});
        let (c, e) = entry_of_event(&nested).unwrap();
        assert_eq!(c.as_deref(), Some("cv_1"));
        assert!(e.is_final && e.text == "hi");
        let flat = json!({"type": "entry", "id": "x", "seq": 4, "turn": 1, "kind": "agent", "text": "hi"});
        assert_eq!(entry_of_event(&flat).unwrap().1.id, "x");
        assert!(entry_of_event(&json!({"type": "bot", "status": "running"})).is_none());
    }

    #[test]
    fn thread_parses_done_and_state() {
        let t = parse_thread(
            &json!({"entries": [{"id": "a", "seq": 1, "kind": "agent", "text": "x", "final": true}, 5], "done": true, "state": "idle"}),
        );
        assert_eq!(t.entries.len(), 1);
        assert!(t.done);
        assert_eq!(t.state, "idle");
    }

    #[test]
    fn stream_prints_only_what_is_new() {
        assert_eq!(suffix("The list", "The list has milk"), Some(" has milk"));
        assert_eq!(suffix("", "abc"), Some("abc"));
        assert_eq!(suffix("abc", "abc"), Some(""));
        assert_eq!(suffix("abc", "xyz"), None);
    }
}
