//! The mapping of a dream's plan onto an agent's files: every kind of change, a refused file, a file that moved on
//! during the run, and undoing a run.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::dream::{self, SECTION};
use super::*;
use kith_mem::dream::{self as kd, Message, Plan};
use kith_mem::rusqlite::params;
use kith_mem::store::Author as EntryAuthor;

struct Home {
    root: PathBuf,
    layout: Layout,
}

impl Home {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kith-hqmem-dream-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("state")).unwrap();
        std::fs::create_dir_all(root.join("agents/builder/memory")).unwrap();
        let root = root.canonicalize().unwrap();
        let layout = Layout::new(root.join("state"), root.join("agents"));
        Self { root, layout }
    }

    fn memory(&self, name: &str) -> PathBuf {
        self.root.join("agents/builder/memory").join(name)
    }

    fn user(&self) -> PathBuf {
        self.root.join("state/user.md")
    }

    fn set(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    /// An agent with an index, a dream section (a time-bound line and a stale preference), and a user.md with
    /// enough lines that a few archives stay under the audit's quarter.
    fn seeded() -> Self {
        let home = Self::new();
        Home::set(
            &home.memory("MEMORY.md"),
            "# Memory\n\n- [Trips](trips.md) — plans\n\n## From conversations\n- Flies to Osaka on 12 Oct 2026\n- Likes coffee\n- Likes jazz\n",
        );
        Home::set(&home.memory("trips.md"), "---\ndescription: Trip plans\n---\n- Osaka in October\n");
        let facts = (1..=12).map(|n| format!("- Fact number {n} about the user\n")).collect::<Vec<_>>().concat();
        Home::set(&home.user(), &format!("# User\n\n{facts}"));
        home.wrote(&["Flies to Osaka on 12 Oct 2026", "Likes coffee"]);
        home
    }

    fn conn(&self) -> Connection {
        open(&self.layout).unwrap()
    }

    /// What a run reads: the lines its earlier runs logged are the dream's own.
    fn load(&self) -> dream::Material {
        let written = dream::written(&self.conn(), "builder").unwrap();
        dream::load(&self.layout, "builder", "2026-10-23", Some(&written)).unwrap().unwrap()
    }

    /// Logs that a run wrote these lines, as one that dreamed before the test did.
    fn wrote(&self, lines: &[&str]) {
        let conn = self.conn();
        conn.execute("INSERT INTO memory_dreams (bot, at, undone) VALUES ('builder', 1, 0)", []).unwrap();
        let run = conn.last_insert_rowid();
        for line in lines {
            conn.execute(
                "INSERT INTO hq_dream_changes (dream, kind, file, shared, text) VALUES (?1, 'added', 'MEMORY.md', 0, ?2)",
                params![run, line],
            )
            .unwrap();
        }
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn said(text: &str) -> Vec<Message> {
    vec![Message { id: "e1".into(), from_user: true, text: vec![text.into()], date: "2026-10-23".into() }]
}

/// What the model proposes, audited like a real run.
fn plan(m: &dream::Material, messages: &[Message], json: &serde_json::Value) -> Plan {
    let plan = kd::parse(&json.to_string()).unwrap();
    let (kept, rejected) = kd::audit(&m.snapshot, messages, plan);
    assert_eq!(rejected, Vec::<String>::new());
    kept
}

fn id_of(m: &dream::Material, text: &str) -> i64 {
    m.snapshot.entries.iter().find(|e| e.text == text).unwrap().id
}

const SAID: &str = "I prefer tea over coffee now, and I fly to Osaka on 12 Oct 2026. My daughter Mei plays the cello.";

#[test]
fn the_model_sees_the_lines_and_only_its_own_can_change() {
    let home = Home::seeded();
    let m = home.load();
    let e = &m.snapshot.entries;
    assert_eq!(e[0].text, "[Trips](trips.md) — plans");
    assert_eq!(e[0].author, EntryAuthor::User, "a line outside the section is not the dream's");
    assert_eq!((e[1].author, e[2].author), (EntryAuthor::Dream, EntryAuthor::Dream));
    assert_eq!(
        e[3].author,
        EntryAuthor::User,
        "a line under the heading that no run logged is the agent's or the user's"
    );
    assert_eq!(e[4].bot, None, "user.md lines are the shared layer");
    assert_eq!(m.snapshot.files.len(), 1);
    assert_eq!(m.snapshot.files[0].description.as_deref(), Some("Trip plans"));
    assert_eq!(m.dream_lines().collect::<Vec<_>>(), ["Flies to Osaka on 12 Oct 2026", "Likes coffee"]);

    let messages = said(SAID);
    let tries = serde_json::json!({"archive": [
        {"id": e[0].id, "quote": "I prefer tea over coffee now", "message": "m1"},
    ]});
    let (kept, rejected) = kd::audit(&m.snapshot, &messages, kd::parse(&tries.to_string()).unwrap());
    assert!(kept.archive.is_empty());
    assert!(rejected[0].contains("the user wrote it"), "{rejected:?}");
}

#[test]
fn every_kind_of_change_lands_in_a_file_and_is_logged() {
    let home = Home::seeded();
    let messages = said(SAID);
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({
            "add": [
                {"text": "Prefers tea over coffee", "quote": "I prefer tea over coffee now", "message": "m1"},
                {"text": "Has a daughter, Mei", "shared": true, "quote": "My daughter Mei plays the cello", "message": "m1"},
            ],
            "archive": [{"id": id_of(&m, "Likes coffee"), "quote": "I prefer tea over coffee now", "message": "m1"}],
            "review": [{"id": id_of(&m, "Flies to Osaka on 12 Oct 2026"), "text": "Flew to Osaka on 12 Oct 2026"}],
            "append": [{"file": "family.md", "text": "Mei plays the cello", "quote": "Mei plays the cello",
                        "message": "m1", "description": "The user's family"}],
        }),
    );
    let conn = home.conn();
    let applied = dream::apply(&conn, &m, &kept).unwrap();
    assert_eq!(applied.dropped, Vec::<String>::new());
    assert_eq!(applied.versions.len(), 3, "MEMORY.md, user.md and the new note");
    let run = applied.dream.unwrap();

    let memory = Home::text(&home.memory("MEMORY.md"));
    assert_eq!(
        memory,
        format!(
            "# Memory\n\n- [Trips](trips.md) — plans\n\n## {SECTION}\n- Flew to Osaka on 12 Oct 2026\n- Likes jazz\n- Prefers tea over coffee\n- [family.md](family.md) — The user's family\n"
        )
    );
    assert!(Home::text(&home.user()).ends_with(&format!("\n\n## {SECTION}\n- Has a daughter, Mei\n")));
    assert_eq!(
        Home::text(&home.memory("family.md")),
        "---\ndescription: The user's family\n---\n- Mei plays the cello\n"
    );

    // The run is in the history with who made it, and its changes read back.
    let t = home.layout.locate(&home.memory("MEMORY.md"), Path::new("/")).unwrap();
    let last = files::versions(&conn, t.bot.as_deref(), &t.name, 1).unwrap().remove(0);
    assert_eq!((last.author, last.cause, last.author_bot.as_deref()), (Author::Dream, Cause::Dream, Some("builder")));
    let runs = dream::runs(&conn, "builder", 10).unwrap();
    assert_eq!(runs[0]["id"], run);
    assert_eq!(runs[0]["undone"], false);
    assert_eq!(runs[0]["files"].as_array().unwrap().len(), 3);
    let kinds: Vec<_> =
        runs[0]["changes"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap().to_owned()).collect();
    for kind in ["archived", "reviewed", "added", "noted", "indexed"] {
        assert!(kinds.iter().any(|k| k == kind), "{kind} in {kinds:?}");
    }
}

#[test]
fn undo_puts_every_file_back_and_the_new_note_goes() {
    let home = Home::seeded();
    let (memory, user) = (Home::text(&home.memory("MEMORY.md")), Home::text(&home.user()));
    let messages = said(SAID);
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({
            "add": [
                {"text": "Prefers tea over coffee", "quote": "I prefer tea over coffee now", "message": "m1"},
                {"text": "Has a daughter, Mei", "shared": true, "quote": "My daughter Mei plays the cello", "message": "m1"},
            ],
            "append": [{"file": "family.md", "text": "Mei plays the cello", "quote": "Mei plays the cello",
                        "message": "m1", "description": "The user's family"}],
        }),
    );
    let conn = home.conn();
    let run = dream::apply(&conn, &m, &kept).unwrap().dream.unwrap();

    let undone = dream::undo(&conn, &home.layout, "builder", run).unwrap();
    assert!(undone.undone && undone.refused.is_empty(), "{undone:?}");
    assert_eq!(Home::text(&home.memory("MEMORY.md")), memory);
    assert_eq!(Home::text(&home.user()), user);
    assert!(!home.memory("family.md").exists(), "the note the run made goes with it");
    assert_eq!(dream::runs(&conn, "builder", 1).unwrap()[0]["undone"], true);
    // What it added is not learned again.
    let t = home.layout.locate(&home.memory("MEMORY.md"), Path::new("/")).unwrap();
    let again = write(&conn, &t, Who::Dream("builder"), &format!("{memory}- Prefers tea over coffee\n")).unwrap();
    assert!(again.is_err(), "undone lines are forgotten");
    // Undoing twice does nothing more.
    assert!(dream::undo(&conn, &home.layout, "builder", run).unwrap().undone);
}

#[test]
fn a_file_changed_after_the_run_is_not_clobbered() {
    let home = Home::seeded();
    let messages = said(SAID);
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({
            "add": [
                {"text": "Prefers tea over coffee", "quote": "I prefer tea over coffee now", "message": "m1"},
                {"text": "Has a daughter, Mei", "shared": true, "quote": "My daughter Mei plays the cello", "message": "m1"},
            ],
        }),
    );
    let conn = home.conn();
    let run = dream::apply(&conn, &m, &kept).unwrap().dream.unwrap();
    let user = Home::text(&home.user());

    // The agent edits MEMORY.md in a later turn; the dream's user.md line is still the newest version there.
    let t = home.layout.locate(&home.memory("MEMORY.md"), Path::new("/")).unwrap();
    let edited = format!("{}- Works on the kith host\n", Home::text(&home.memory("MEMORY.md")));
    write(&conn, &t, Who::Agent("builder"), &edited).unwrap().unwrap();

    let undone = dream::undo(&conn, &home.layout, "builder", run).unwrap();
    assert!(!undone.undone, "one file stays, so the run is not undone");
    assert_eq!(undone.refused.len(), 1);
    assert_eq!(undone.refused[0].0, "builder/MEMORY.md");
    assert!(undone.refused[0].1.contains("changed after the dream (by builder)"), "{:?}", undone.refused);
    assert_eq!(Home::text(&home.memory("MEMORY.md")), edited, "the agent's edit stays");
    assert_ne!(Home::text(&home.user()), user, "user.md went back");
    assert!(!Home::text(&home.user()).contains("Mei"));

    // A run whose only file moved on can restore nothing: it says why.
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({"add": [{"text": "Plays the cello", "quote": "Mei plays the cello", "message": "m1"}]}),
    );
    let second = dream::apply(&conn, &m, &kept).unwrap().dream.unwrap();
    write(&conn, &t, Who::Kai, &format!("{edited}- By hand\n")).unwrap().unwrap();
    let error = dream::undo(&conn, &home.layout, "builder", second).unwrap_err().to_string();
    assert!(error.contains("changed after the dream (by you)"), "{error}");
}

#[test]
fn a_refused_file_is_dropped_and_logged_not_retried() {
    let home = Home::seeded();
    let messages = said(SAID);
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({
            "add": [
                {"text": "Prefers tea over coffee", "quote": "I prefer tea over coffee now", "message": "m1"},
                {"text": "Has a daughter, Mei", "shared": true, "quote": "My daughter Mei plays the cello", "message": "m1"},
            ],
        }),
    );
    let conn = home.conn();
    forget(&conn, "Has a daughter, Mei").unwrap();
    let before = Home::text(&home.user());
    let applied = dream::apply(&conn, &m, &kept).unwrap();
    assert_eq!(Home::text(&home.user()), before, "the refused file is untouched");
    assert!(Home::text(&home.memory("MEMORY.md")).contains("Prefers tea over coffee"), "the others still land");
    assert_eq!(applied.dropped.len(), 1);
    assert!(
        applied.dropped[0].starts_with("user.md:") && applied.dropped[0].contains("deleted this memory"),
        "{:?}",
        applied.dropped
    );
    assert_eq!(applied.versions.len(), 1);

    // Nothing left to write: no run is logged at all.
    let only = plan(
        &m,
        &messages,
        &serde_json::json!({"add": [{"text": "Has a daughter, Mei", "shared": true,
            "quote": "My daughter Mei plays the cello", "message": "m1"}]}),
    );
    let none = dream::apply(&conn, &home.load(), &only).unwrap();
    assert!(!none.stale);
    assert!(none.dream.is_none() && none.versions.is_empty());
    assert_eq!(dream::runs(&conn, "builder", 10).unwrap().len(), 2, "the seeded run and the first one");
}

#[test]
fn a_file_that_changed_during_the_run_makes_it_stale() {
    let home = Home::seeded();
    let messages = said(SAID);
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({"add": [{"text": "Prefers tea over coffee", "quote": "I prefer tea over coffee now", "message": "m1"}]}),
    );
    let during = format!("{}- Added by the agent mid-run\n", Home::text(&home.memory("MEMORY.md")));
    Home::set(&home.memory("MEMORY.md"), &during);
    let conn = home.conn();
    let applied = dream::apply(&conn, &m, &kept).unwrap();
    assert!(applied.stale && applied.dream.is_none());
    assert_eq!(Home::text(&home.memory("MEMORY.md")), during);
}

#[test]
fn missing_files_are_created_and_a_full_memory_moves_a_line_to_a_note() {
    let home = Home::new();
    let messages = said(SAID);
    let m = home.load();
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({"add": [
            {"text": "Prefers tea over coffee", "quote": "I prefer tea over coffee now", "message": "m1"},
            {"text": "Has a daughter, Mei", "shared": true, "quote": "My daughter Mei plays the cello", "message": "m1"},
        ]}),
    );
    let conn = home.conn();
    dream::apply(&conn, &m, &kept).unwrap();
    assert_eq!(Home::text(&home.memory("MEMORY.md")), format!("# Memory\n\n## {SECTION}\n- Prefers tea over coffee\n"));
    assert!(Home::text(&home.user()).contains("- Has a daughter, Mei"));

    // Nearly full: a line the dream wrote moves into a note, which the index then names.
    home.wrote(&["Reads on the train"]);
    let filler = (1..=140).map(|n| format!("- Filler line {n}\n")).collect::<Vec<_>>().concat();
    Home::set(&home.memory("MEMORY.md"), &format!("# Memory\n\n{filler}\n## {SECTION}\n- Reads on the train\n"));
    let m = home.load();
    assert!(m.snapshot.full);
    let kept = plan(
        &m,
        &messages,
        &serde_json::json!({"moveOut": [{"id": id_of(&m, "Reads on the train"), "file": "habits.md", "description": "Habits"}]}),
    );
    dream::apply(&conn, &m, &kept).unwrap();
    let memory = Home::text(&home.memory("MEMORY.md"));
    assert!(!memory.contains("- Reads on the train"));
    assert!(memory.contains("- [habits.md](habits.md) — Habits"));
    assert_eq!(Home::text(&home.memory("habits.md")), "---\ndescription: Habits\n---\n- Reads on the train\n");
}

#[test]
fn only_an_agents_own_folder_is_dreamed() {
    let home = Home::new();
    assert!(dream::load(&home.layout, "ghost", "2026-10-23", None).unwrap().is_none());
    assert!(dream::load(&home.layout, "../builder", "2026-10-23", None).unwrap().is_none());
    assert!(dream::target_of(&home.layout, "builder", false, "../role/agent.md").is_none());
    assert!(dream::target_of(&home.layout, "builder", true, "settings.json").is_none());
}

#[test]
fn the_apps_save_read_diff_and_restore_a_file() {
    let home = Home::seeded();
    let conn = home.conn();
    let l = &home.layout;
    let listed = list_files(l, "builder").unwrap();
    let names: Vec<_> = listed["agent"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["MEMORY.md", "trips.md"]);
    assert_eq!(listed["shared"][0]["name"], "user.md");

    let first = read_file(l, "builder", false, "trips.md").unwrap();
    assert!(first["text"].as_str().unwrap().contains("Osaka in October"));
    // Kai's save is never refused: text an agent's write would be refused for passes (it warns at most).
    let saved = save(&conn, l, "builder", false, "trips.md", "- the key is sk-abcdefghijklmnopqrst\n").unwrap();
    assert_eq!(saved["version"]["author"], "kai");
    let log = history(&conn, l, "builder", false, "trips.md", 10).unwrap();
    let versions = log["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2, "the baseline and the save");
    assert_eq!(versions[1]["cause"], "baseline");
    let (new, old) = (versions[0]["id"].as_i64().unwrap(), versions[1]["id"].as_i64().unwrap());
    let changes = diff(&conn, l, "builder", false, "trips.md", None, None).unwrap();
    assert_eq!((changes["from"].as_i64(), changes["to"].as_i64()), (Some(old), Some(new)));
    assert!(changes["diff"].as_str().unwrap().contains("+ - the key is"));
    restore(&conn, l, "builder", false, "trips.md", old).unwrap();
    assert!(Home::text(&home.memory("trips.md")).contains("Osaka in October"));
    let log = history(&conn, l, "builder", false, "trips.md", 10).unwrap();
    assert_eq!(log["versions"][0]["cause"], "restore");
    // Another file's version can't be restored into this one, and a path outside memory is no file.
    assert!(restore(&conn, l, "builder", false, "MEMORY.md", old).is_err());
    assert!(read_file(l, "builder", false, "../role/agent.md").is_err());
}
