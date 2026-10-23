//! Reads and writes for the thread summaries (`kith_mem::summary`) that need the entries table.
//!
//! A thread's root entry sits in the chat itself (its `thread_id` is empty) and the replies carry the root's id. For a
//! summary the root is the thread's first message and belongs to the thread, not to the chat's own conversation.

use super::Store;
use super::entries::{ENTRY_COLS, row_entry};
use super::model::Entry;
use crate::LockExt;
use anyhow::Result;
use rusqlite::params;

/// One lane's activity: its thread (None is the bot's own chat), newest chat message and how many there are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    pub thread: Option<String>,
    pub last_seq: i64,
    pub last_at: i64,
    pub messages: i64,
}

/// A chat message: the user's, or a final reply.
const CHAT: &str = "(e.kind = 'user' OR (e.kind = 'agent' AND json_extract(e.data, '$.final') = 1))";
/// The lane an entry belongs to: its thread, or its own id when it is a thread's root, else none (the chat itself).
const LANE: &str = "COALESCE(e.thread_id, CASE WHEN EXISTS (SELECT 1 FROM entries c WHERE c.bot_id = e.bot_id AND c.thread_id = e.id) THEN e.id END)";

impl Store {
    /// The lanes of `bot` with a chat message after `since_seq`, and the newest of each.
    pub fn lanes_active_since(&self, bot: &str, since_seq: i64) -> Result<Vec<Activity>> {
        let c = self.db.locked();
        let mut st = c.prepare(&format!(
            "SELECT {LANE}, MAX(e.seq), MAX(e.created_at), COUNT(*) FROM entries e
             WHERE e.bot_id = ?1 AND e.seq > ?2 AND {CHAT} GROUP BY {LANE}"
        ))?;
        let rows = st.query_map(params![bot, since_seq], |r| {
            Ok(Activity { thread: r.get(0)?, last_seq: r.get(1)?, last_at: r.get(2)?, messages: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The newest chat message of a lane and how many it has (all of them, not only since a bookmark).
    pub fn lane_stats(&self, bot: &str, thread: Option<&str>) -> Result<(i64, i64)> {
        let c = self.db.locked();
        Ok(c.query_row(
            &format!(
                "SELECT COALESCE(MAX(e.seq), 0), COUNT(*) FROM entries e WHERE e.bot_id = ?1 AND {CHAT} AND
                   (({LANE}) IS ?2)"
            ),
            params![bot, thread],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// A lane's newest `limit` chat messages, oldest first: a thread's root and replies, or the chat's own
    /// conversation without the roots of its threads.
    pub fn lane_chat(&self, bot: &str, thread: Option<&str>, limit: i64) -> Result<Vec<Entry>> {
        let c = self.db.locked();
        let cols = ENTRY_COLS.split(", ").map(|c| format!("e.{c}")).collect::<Vec<_>>().join(", ");
        let mut st = c.prepare(&format!(
            "SELECT {cols} FROM entries e WHERE e.bot_id = ?1 AND {CHAT} AND (({LANE}) IS ?2)
             ORDER BY e.seq DESC LIMIT ?3"
        ))?;
        let mut rows: Vec<Entry> =
            st.query_map(params![bot, thread, limit], row_entry)?.collect::<rusqlite::Result<_>>()?;
        rows.reverse();
        Ok(rows)
    }

    /// Runs `f` on the connection: the thread summaries are written outside a memory change (no `rev` to stamp,
    /// nothing for clients to refetch).
    pub fn with_db<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
        f(&self.db.locked())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{EntryKind, Lane};
    use serde_json::json;

    fn store() -> Store {
        Store::open(&std::env::temp_dir().join(format!("kith-threads-{}.db", uuid::Uuid::new_v4()))).unwrap()
    }

    #[test]
    fn a_threads_root_belongs_to_the_thread() {
        let s = store();
        let main = Lane::main("b1");
        let plain = s.insert_entry(&main, EntryKind::User, 1, &json!({"text": "plain"})).unwrap();
        let root = s.insert_entry(&main, EntryKind::User, 2, &json!({"text": "root"})).unwrap();
        let reply = Lane::in_thread("b1", &root.id);
        s.insert_entry(&reply, EntryKind::Agent, 2, &json!({"text": "answer", "final": true})).unwrap();
        s.insert_entry(&reply, EntryKind::Agent, 2, &json!({"text": "narration", "final": false})).unwrap();
        let texts = |t: Option<&str>| -> Vec<String> {
            s.lane_chat("b1", t, 10).unwrap().iter().map(|e| e.data["text"].as_str().unwrap().to_owned()).collect()
        };
        assert_eq!(texts(Some(&root.id)), ["root", "answer"]);
        assert_eq!(texts(None), ["plain"], "the chat keeps its own messages, not its threads' roots");
        assert_eq!(s.lane_stats("b1", Some(&root.id)).unwrap().1, 2);
        assert_eq!(s.lane_stats("b1", None).unwrap(), (plain.seq, 1));
        let mut lanes = s.lanes_active_since("b1", 0).unwrap();
        lanes.sort_by_key(|l| l.messages);
        assert_eq!(
            lanes.iter().map(|l| (l.thread.clone(), l.messages)).collect::<Vec<_>>(),
            [(None, 1), (Some(root.id), 2)]
        );
        assert_eq!(s.lanes_active_since("b1", plain.seq + 100).unwrap().len(), 0);
    }
}
