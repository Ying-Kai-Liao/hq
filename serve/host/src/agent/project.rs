//! The project of a chat, decided per turn from what is being discussed (docs/memory-context.md, "Project inference per
//! turn, and the divider").
//!
//! Cheap and deterministic: the user's message (and, once, the last couple of their messages) is searched for the ids,
//! names and folders of the projects hq knows; no model is called. A thread keeps its project set unless the subject
//! clearly moved, and moves at most once in a few messages, so a stray mention doesn't flap it. A person's correction
//! is the same kind of state with `by: "person"`, and the same rule moves it on. `BotConfig.project` is an explicit pin
//! and is never inferred over (the caller leaves this module out of it).

use crate::agent::hq::Project;
use crate::store::{Lane, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A thread's current project set moves again (by inference) only after this many messages of staying.
const COOLDOWN: u32 = 3;

/// Folder names too generic to say anything about a project.
const GENERIC: &[&str] = &[
    "src",
    "code",
    "work",
    "home",
    "main",
    "test",
    "tests",
    "docs",
    "app",
    "apps",
    "web",
    "site",
    "notes",
    "misc",
    "temp",
    "tmp",
    "data",
    "documents",
    "desktop",
    "projects",
    "project",
    "repos",
    "github",
    "workspace",
    "dev",
    "build",
    "dist",
    "lib",
    "bin",
    "public",
    "private",
    "files",
    "downloads",
    "users",
];

/// What marks a project in a message: lowercase needles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    needles: Vec<String>,
}

pub fn candidates(list: &[Project]) -> Vec<Candidate> {
    list.iter()
        .filter(|p| p.id.chars().count() >= 3)
        .map(|p| {
            let id = p.id.to_lowercase();
            let mut needles = vec![id.clone()];
            if id.contains(['-', '_']) {
                needles.push(id.replace(['-', '_'], " "));
            }
            for path in p.home.iter().chain(&p.paths) {
                let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_lowercase();
                if name.chars().count() >= 4 && !GENERIC.contains(&name.as_str()) && !needles.contains(&name) {
                    needles.push(name);
                }
            }
            Candidate { id: p.id.clone(), needles }
        })
        .collect()
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

/// Whether `needle` stands as a word of `hay` (both lowercase). Dashes and underscores belong to the word, so
/// `peace-guardian-ui` is not a mention of `peace-guardian`.
fn has_word(hay: &str, needle: &str) -> bool {
    hay.match_indices(needle).any(|(at, _)| {
        let before = hay[..at].chars().next_back();
        let after = hay[at + needle.len()..].chars().next();
        !before.is_some_and(word_char) && !after.is_some_and(word_char)
    })
}

/// The ids of the projects `text` names, in the order of `cands`.
pub fn mentioned(cands: &[Candidate], text: &str) -> Vec<String> {
    let hay = text.to_lowercase();
    cands.iter().filter(|c| c.needles.iter().any(|n| has_word(&hay, n))).map(|c| c.id.clone()).collect()
}

/// A thread's project state, kept between messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub projects: Vec<String>,
    /// `inferred` or `person`.
    pub by: String,
    /// Messages since the set last changed.
    pub since: u32,
}

/// A change of the set, as the divider shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub from: Vec<String>,
    pub to: Vec<String>,
}

pub struct Decision {
    pub state: State,
    /// Set when the thread moved from one known set to another: apps show "Now on <project>".
    pub change: Option<Change>,
    /// Projects that became current with this message: their tier-1 notes go with the turn.
    pub newly: Vec<String>,
}

/// The set for a message. `now`: projects the message names; `recent`: those the last messages named (used only to
/// start a thread that has none yet). No state means the thread was never looked at: it is set without a divider.
pub fn decide(state: Option<&State>, now: &[String], recent: &[String]) -> Decision {
    let Some(state) = state else {
        let projects = if now.is_empty() { recent.to_vec() } else { now.to_vec() };
        return Decision {
            newly: projects.clone(),
            state: State { projects, by: "inferred".into(), since: 0 },
            change: None,
        };
    };
    let stays = now.is_empty() || now.iter().any(|p| state.projects.contains(p));
    let mut next = State { since: state.since.saturating_add(1), ..state.clone() };
    if stays || state.since < COOLDOWN {
        return Decision { state: next, change: None, newly: Vec::new() };
    }
    next = State { projects: now.to_vec(), by: "inferred".into(), since: 0 };
    let newly = now.iter().filter(|p| !state.projects.contains(p)).cloned().collect();
    Decision { change: Some(Change { from: state.projects.clone(), to: now.to_vec() }), state: next, newly }
}

/// Inference and correction both read then write a thread's state; one at a time, so two messages can't undo each other.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn key(lane: &Lane) -> String {
    format!("thread-project:{}", lane.key())
}

pub fn read(store: &Store, lane: &Lane) -> Option<State> {
    serde_json::from_str(&store.kv_get(&key(lane))?).ok()
}

fn write(store: &Store, lane: &Lane, state: &State) {
    if let Err(error) = store.kv_set(&key(lane), &json!(state).to_string()) {
        tracing::warn!(error = format!("{error:#}"), "couldn't save a thread's project");
    }
}

/// The `projectChange` of a notice entry: `{from, to, by}`.
pub fn change_data(from: &[String], to: &[String], by: &str) -> Value {
    json!({"from": from, "to": to, "by": by})
}

/// The divider's words.
pub fn divider_text(to: &[String]) -> String {
    if to.is_empty() { "Now on no project".to_owned() } else { format!("Now on {}", to.join(", ")) }
}

/// Infers the thread's project set for the message `text`, saves it, and says what changed. `recent`: the user's
/// last messages before this one.
pub fn infer(store: &Store, lane: &Lane, known: &[Project], text: &str, recent: &[String]) -> Decision {
    let cands = candidates(known);
    let now = mentioned(&cands, text);
    let before: Vec<String> = recent.iter().flat_map(|t| mentioned(&cands, t)).fold(Vec::new(), |mut all, p| {
        if !all.contains(&p) {
            all.push(p);
        }
        all
    });
    let _one = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let decision = decide(read(store, lane).as_ref(), &now, &before);
    write(store, lane, &decision.state);
    decision
}

/// A person's correction: the set is theirs from now on, until the subject clearly moves. Returns the change when the
/// set differs from what the thread had.
pub fn correct(store: &Store, lane: &Lane, projects: Vec<String>) -> (State, Option<Change>) {
    let _one = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let from = read(store, lane).map(|w| w.projects).unwrap_or_default();
    let state = State { projects, by: "person".into(), since: 0 };
    write(store, lane, &state);
    let change = (from != state.projects).then(|| Change { from, to: state.projects.clone() });
    (state, change)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, paths: &[&str]) -> Project {
        serde_json::from_value(json!({"id": id, "paths": paths})).unwrap()
    }

    fn known() -> Vec<Candidate> {
        candidates(&[
            project("peace-guardian", &["/Users/me/Documents/guardian-app"]),
            project("peace-guardian-ui", &[]),
            project("kith", &["/Users/me/src"]),
            project("ab", &[]),
        ])
    }

    fn set(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn ids_names_and_folders_are_matched_as_words() {
        let c = known();
        assert_eq!(mentioned(&c, "fix the Peace-Guardian login"), set(&["peace-guardian"]));
        assert_eq!(mentioned(&c, "the peace guardian login"), set(&["peace-guardian"]));
        assert_eq!(mentioned(&c, "see guardian-app/README"), set(&["peace-guardian"]));
        assert_eq!(mentioned(&c, "peace-guardian-ui is slow"), set(&["peace-guardian-ui"]), "the longer id is its own");
        assert_eq!(mentioned(&c, "kith and peace-guardian"), set(&["peace-guardian", "kith"]));
        assert_eq!(mentioned(&c, "ab is too short; src is generic; kithara is another word"), set(&[]));
    }

    #[test]
    fn an_unseen_thread_is_set_without_a_divider() {
        let d = decide(None, &set(&["kith"]), &[]);
        assert_eq!(d.state.projects, set(&["kith"]));
        assert!(d.change.is_none());
        assert_eq!(d.newly, set(&["kith"]));
        let d = decide(None, &[], &set(&["kith"]));
        assert_eq!(d.state.projects, set(&["kith"]), "the last messages start it");
        let d = decide(None, &[], &[]);
        assert!(d.state.projects.is_empty() && d.change.is_none());
    }

    #[test]
    fn no_change_means_no_notice_and_no_injection() {
        let s = State { projects: set(&["kith"]), by: "inferred".into(), since: 10 };
        for now in [vec![], set(&["kith"]), set(&["kith", "other"])] {
            let d = decide(Some(&s), &now, &[]);
            assert!(d.change.is_none() && d.newly.is_empty(), "{now:?}");
            assert_eq!(d.state.projects, s.projects);
            assert_eq!(d.state.since, 11);
        }
    }

    #[test]
    fn a_clear_move_is_one_notice_and_flapping_waits() {
        let s = State { projects: set(&["kith"]), by: "inferred".into(), since: COOLDOWN };
        let d = decide(Some(&s), &set(&["peace-guardian"]), &[]);
        let change = d.change.expect("moved");
        assert_eq!((change.from, change.to), (set(&["kith"]), set(&["peace-guardian"])));
        assert_eq!(d.newly, set(&["peace-guardian"]));
        assert_eq!((d.state.since, d.state.by.as_str()), (0, "inferred"));
        // Right after, a move back is held until the cooldown has passed.
        let back = decide(Some(&d.state), &set(&["kith"]), &[]);
        assert!(back.change.is_none() && back.state.projects == set(&["peace-guardian"]));
    }

    #[test]
    fn a_thread_with_no_project_gets_one_when_the_subject_names_it() {
        let s = State { projects: vec![], by: "inferred".into(), since: 5 };
        let d = decide(Some(&s), &set(&["kith"]), &[]);
        assert_eq!(d.change.map(|c| (c.from, c.to)), Some((vec![], set(&["kith"]))));
    }

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("kith-project-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (Store::open(&dir.join("db.sqlite")).unwrap(), dir)
    }

    #[test]
    fn a_correction_wins_until_the_subject_moves() {
        let (store, dir) = store();
        let lane = Lane::in_thread("b", "root");
        let list = [project("kith", &[]), project("peace-guardian", &[])];
        let first = infer(&store, &lane, &list, "working on kith", &[]);
        assert_eq!(first.state.projects, set(&["kith"]));
        let (state, change) = correct(&store, &lane, set(&["peace-guardian"]));
        assert_eq!(state.by, "person");
        assert_eq!(change.map(|c| c.to), Some(set(&["peace-guardian"])));
        // A message that names nothing, or the corrected project, keeps it.
        for text in ["and the colours?", "peace-guardian again"] {
            let d = infer(&store, &lane, &list, text, &[]);
            assert_eq!(d.state.projects, set(&["peace-guardian"]), "{text}");
            assert!(d.change.is_none());
            assert_eq!(d.state.by, "person");
        }
        // After the cooldown a clear move by the subject takes it back to inference.
        for _ in 0..COOLDOWN {
            infer(&store, &lane, &list, "more", &[]);
        }
        let d = infer(&store, &lane, &list, "kith needs a fix", &[]);
        assert!(d.change.is_some());
        assert_eq!(d.state.by, "inferred");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn state_is_kept_per_place() {
        let (store, dir) = store();
        let list = [project("kith", &[])];
        infer(&store, &Lane::in_thread("b", "one"), &list, "kith", &[]);
        assert!(read(&store, &Lane::in_thread("b", "two")).is_none());
        assert!(read(&store, &Lane::in_thread("b", "one")).is_some());
        std::fs::remove_dir_all(dir).ok();
    }
}
