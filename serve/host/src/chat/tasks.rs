//! Tasks: what the user says to a bot comes in bursts, and each burst is a task of its own. Its first message is a
//! root in the bot's chat (`data.task`), the rest of it and the bot's answers its thread, with a fresh agent session
//! (see `agent::bot::session`) that runs beside the bot's other tasks. Clients show a task inline while it's going and
//! fold it into a card once it's idle.

use crate::hub::Hub;
use crate::store::{BotConfig, Entry, EntryKind, Lane};

/// Where a task stands, as the host says it (`data.thread.status` on the task's root). Clients that find none (an
/// older host, a terminal's thread) work it out from the thread's entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Working,
    NeedsYou,
    Stopped,
    Failed,
    Done,
}

impl TaskState {
    /// How a finished turn leaves its task: a stop, an error or a limit (anything but a normal end) is not done.
    pub fn after_turn(stopped: bool, failed: bool, stop_reason: &str) -> Self {
        if stopped {
            Self::Stopped
        } else if failed || stop_reason != "end_turn" {
            Self::Failed
        } else {
            Self::Done
        }
    }
}

/// A task idle this long is over: the next message starts a new one.
const IDLE_MS: i64 = 10 * 60 * 1000;

/// How far back in the bot's chat the current task is looked for.
const LOOKBACK: i64 = 50;

/// The thread a message to `bot`'s chat continues, or `None` when it starts a task of its own: asked for
/// (`new_task`), or no task is going (the newest is idle and not working).
pub fn continued(hub: &Hub, bot: &BotConfig, new_task: bool, now: i64) -> Option<String> {
    if new_task {
        return None;
    }
    let root = current(hub, &bot.id)?;
    let working = hub.working_lanes(bot).contains(&Lane::in_thread(&bot.id, &root.id));
    goes_on(&root, working, now).then_some(root.id)
}

/// Marks a message as the start of a task.
pub fn mark(data: &mut serde_json::Value) {
    data["task"] = true.into();
}

/// Whether the root `entry` started a task.
pub fn is_task(entry: &Entry) -> bool {
    entry.data["task"] == true
}

/// The bot's newest task, if one is recent enough to look at.
fn current(hub: &Hub, bot: &str) -> Option<Entry> {
    let recent = match hub.store.history(bot, i64::MAX, LOOKBACK) {
        Ok(recent) => recent,
        Err(e) => {
            tracing::warn!(bot, error = format!("{e:#}"), "couldn't read the chat for its current task");
            return None;
        }
    };
    // A terminal session's thread is continued by naming it, never by the next burst of talk.
    recent
        .into_iter()
        .rev()
        .find(|e| e.kind == EntryKind::User.as_str() && is_task(e) && e.data["thread"]["origin"] != "terminal")
}

/// A task goes on while it works, and until it has been idle for [`IDLE_MS`].
fn goes_on(root: &Entry, working: bool, now: i64) -> bool {
    let last = root.data["thread"]["lastAt"].as_i64().filter(|&at| at > 0).unwrap_or(root.created_at);
    working || now - last < IDLE_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(created_at: i64, last_at: Option<i64>) -> Entry {
        let mut data = json!({"text": "fix the build", "task": true});
        if let Some(at) = last_at {
            data["thread"] = json!({"count": 2, "lastAt": at});
        }
        Entry {
            id: "r".into(),
            seq: 1,
            bot_id: "b".into(),
            thread_id: None,
            rev: 1,
            kind: "user".into(),
            turn: 1,
            data,
            created_at,
            updated_at: created_at,
        }
    }

    #[tokio::test]
    async fn the_host_says_failed_for_a_failed_turn_and_done_for_a_normal_one() {
        use crate::store::{EntryKind, Store};
        let dir = std::env::temp_dir().join(format!("kith-tasks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let identity = crate::remote::identity::Identity::load_or_create(&dir).unwrap();
        let hub = Hub::new(store, "tasks-test".into(), identity, "t".into(), 0);
        let status = |root: &str| hub.store.entry(root).unwrap().data["thread"]["status"].clone();
        for (state, want) in [
            (TaskState::after_turn(false, true, "error"), "failed"),
            (TaskState::after_turn(false, false, "end_turn"), "done"),
        ] {
            let root =
                hub.add_entry(&Lane::main("b"), EntryKind::User, 1, &json!({"text": "go", "task": true})).unwrap();
            let lane = Lane::in_thread("b", &root.id);
            hub.set_task_status(&lane, TaskState::Working);
            assert_eq!(status(&root.id), "working");
            hub.add_entry(&lane, EntryKind::Agent, 1, &json!({"text": "hi", "final": true})).unwrap();
            assert_eq!(status(&root.id), "working", "a reply's refresh keeps the status");
            hub.set_task_status(&lane, state);
            assert_eq!(status(&root.id), want);
            // A retried turn goes back to working.
            hub.set_task_status(&lane, TaskState::Working);
            assert_eq!(status(&root.id), "working");
        }
    }

    #[test]
    fn a_turn_that_fails_or_hits_a_limit_leaves_its_task_failed() {
        assert_eq!(TaskState::after_turn(false, false, "end_turn"), TaskState::Done);
        assert_eq!(TaskState::after_turn(false, true, "error"), TaskState::Failed);
        assert_eq!(TaskState::after_turn(false, false, "max_tokens"), TaskState::Failed);
        assert_eq!(TaskState::after_turn(true, false, "cancelled"), TaskState::Stopped);
        assert_eq!(serde_json::json!(TaskState::NeedsYou), "needsYou");
    }

    #[test]
    fn a_task_goes_on_until_ten_idle_minutes_unless_it_works() {
        let now = 100 * IDLE_MS;
        assert!(goes_on(&root(now - 60_000, None), false, now), "a minute after it started");
        assert!(!goes_on(&root(now - IDLE_MS, None), false, now), "ten quiet minutes end it");
        assert!(goes_on(&root(now - 3 * IDLE_MS, Some(now - 60_000)), false, now), "its last reply counts");
        assert!(!goes_on(&root(now - 3 * IDLE_MS, Some(now - 2 * IDLE_MS)), false, now));
        assert!(goes_on(&root(now - 3 * IDLE_MS, Some(now - 2 * IDLE_MS)), true, now), "a working task goes on");
    }
}
