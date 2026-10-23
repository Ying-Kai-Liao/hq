//! Property tests for `roles`: whatever the method, body, store and kith-auth answer, an invited person never gets
//! more than they were granted. The real `roles` functions run against a real store and a stand-in `kith-auth`
//! (a shell script answering from a table written per case), so the subprocess path is the product's own.
//! Method: `.claude/skills/invitee-access/SKILL.md`. Run only these: `cargo test roles_props`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::devices::NotAllowed;
use super::roles::{self, MEMBER_METHODS, UNPROVEN_METHODS};
use crate::agent::folder::{Change, Pick};
use crate::channels::hq::TEST_ENV;
use crate::hub::Hub;
use crate::remote::account::{ONE_AT_A_TIME, TEST_BIN};
use crate::remote::identity::Identity;
use crate::store::{BotConfig, EntryKind, Lane, Store};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use serde_json::{Value, json};
use std::cell::Cell;
use std::path::PathBuf;
use std::sync::Arc;

const PEOPLE: [&str; 2] = ["p1", "p2"];
const AGENTS: [&str; 2] = ["a1", "a2"];
const PROJECTS: [&str; 2] = ["pr1", "pr2"];

/// Cases per property; `PROPTEST_CASES` overrides it (the CI default keeps the module near ten seconds).
fn runner() -> TestRunner {
    let mut config = Config { failure_persistence: None, ..Config::default() };
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 96;
    }
    TestRunner::new(config)
}

// ---- the stand-in kith-auth ----

/// What the stand-in prints for one (person, agent). `Fail` is "no answer" (exit 1, nothing printed).
#[derive(Clone, Debug)]
enum Ans {
    Fail,
    Garbage(usize),
    Denied(bool),
    Member,
    Guest,
    Other(usize),
    NoPreset,
    OwnerTrue,
}

const GARBAGE: [&str; 10] = [
    "",
    "not json",
    "[]",
    "null",
    "true",
    r#"{"allowed":"true"}"#,
    r#"{"allowed":1}"#,
    r#"{"allowed":true"#,
    r#"{"allowed":null,"preset":"member"}"#,
    r#"{"allowed":[true],"preset":"member"}"#,
];
const OTHER_PRESETS: [&str; 4] = ["viewer", "MEMBER", "member ", ""];

impl Ans {
    fn text(&self) -> Option<String> {
        Some(match self {
            Self::Fail => return None,
            Self::Garbage(i) => GARBAGE[*i % GARBAGE.len()].to_owned(),
            Self::Denied(with_member) => {
                json!({"allowed": false, "preset": with_member.then_some("member")}).to_string()
            }
            Self::Member => json!({"allowed": true, "preset": "member"}).to_string(),
            Self::Guest => json!({"allowed": true, "preset": "guest"}).to_string(),
            Self::Other(i) => json!({"allowed": true, "preset": OTHER_PRESETS[*i % OTHER_PRESETS.len()]}).to_string(),
            Self::NoPreset => json!({"allowed": true}).to_string(),
            // The owner never comes through `roles`; a person answered as owner is refused.
            Self::OwnerTrue => json!({"allowed": true, "owner": true, "preset": "member"}).to_string(),
        })
    }

    /// What kith-auth means, by label (not by re-parsing): a grant of any preset, never the owner.
    fn allowed(&self) -> bool {
        matches!(self, Self::Member | Self::Guest | Self::Other(_) | Self::NoPreset)
    }

    fn member(&self) -> bool {
        matches!(self, Self::Member)
    }
}

fn ans() -> impl Strategy<Value = Ans> {
    prop_oneof![
        2 => Just(Ans::Fail),
        2 => (0..GARBAGE.len()).prop_map(Ans::Garbage),
        2 => any::<bool>().prop_map(Ans::Denied),
        3 => Just(Ans::Member),
        2 => Just(Ans::Guest),
        1 => (0..OTHER_PRESETS.len()).prop_map(Ans::Other),
        1 => Just(Ans::NoPreset),
        1 => Just(Ans::OwnerTrue),
    ]
}

// ---- the world one case runs in ----

#[derive(Clone, Debug)]
struct PersonSpec {
    agents: [bool; 2],
    projects: [bool; 2],
}

#[derive(Clone, Debug)]
struct BotSpec {
    /// 0 the owner's, 1 and 2 the people.
    owner: usize,
    deleted: bool,
    /// 0 none, 1 and 2 the agents.
    agent: usize,
}

#[derive(Clone, Debug)]
struct EntrySpec {
    /// Index into the bots; `BOTS` is a bot the store never had.
    bot: usize,
    permission: bool,
    /// 0 none, 1 its own chat, 2 another bot, 3 not a string.
    author: usize,
}

const BOTS: usize = 4;

#[derive(Clone, Debug)]
struct Scenario {
    grants: [[Ans; 2]; 2],
    people: [Option<PersonSpec>; 2],
    bots: Vec<BotSpec>,
    entries: Vec<EntrySpec>,
}

fn scenario() -> impl Strategy<Value = Scenario> {
    let person = proptest::option::weighted(
        0.85,
        (any::<[bool; 2]>(), any::<[bool; 2]>()).prop_map(|(agents, projects)| PersonSpec { agents, projects }),
    );
    let bot = (0..3usize, proptest::bool::weighted(0.2), 0..3usize).prop_map(|(owner, deleted, agent)| BotSpec {
        owner,
        deleted,
        agent,
    });
    let entry = (0..=BOTS, proptest::bool::weighted(0.7), 0..4usize).prop_map(|(bot, permission, author)| EntrySpec {
        bot,
        permission,
        author,
    });
    (
        [[ans(), ans()], [ans(), ans()]],
        [person.clone(), person],
        proptest::collection::vec(bot, BOTS),
        proptest::collection::vec(entry, 0..4),
    )
        .prop_map(|(grants, people, bots, entries)| Scenario { grants, people, bots, entries })
}

struct World {
    rt: tokio::runtime::Runtime,
    hub: Arc<Hub>,
    dir: PathBuf,
    case: Cell<u64>,
    _one_at_a_time: tokio::sync::MutexGuard<'static, ()>,
}

/// Ids of what one case put in the store.
struct Ids {
    bots: Vec<String>,
    ghost: String,
    entries: Vec<String>,
}

impl World {
    fn new() -> Self {
        let guard = ONE_AT_A_TIME.blocking_lock();
        let dir = std::env::temp_dir().join(format!("kith-roles-props-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("grants")).unwrap();
        let bin = dir.join("kith-auth");
        // `kith-auth resolve AGENT --person PERSON`: the canned answer of that pair, failing when there is none.
        std::fs::write(&bin, "#!/bin/sh\n[ \"$1\" = resolve ] && [ \"$3\" = --person ] || exit 2\nf=\"$KITH_FAKE/$4__$2\"\n[ -f \"$f\" ] || exit 1\ncat \"$f\"\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        *TEST_ENV.lock().unwrap() = vec![("KITH_FAKE", dir.join("grants"))];
        *TEST_BIN.lock().unwrap() = Some(bin);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let hub = rt.block_on(async {
            let store = Store::open(&dir.join("t.db")).unwrap();
            Hub::new(store, "host".into(), Identity::load_or_create(&dir).unwrap(), "token".into(), 0)
        });
        Self { rt, hub, dir, case: Cell::new(0), _one_at_a_time: guard }
    }

    fn write_grants(&self, grants: &[[Ans; 2]; 2]) {
        let d = self.dir.join("grants");
        std::fs::remove_dir_all(&d).unwrap();
        std::fs::create_dir_all(&d).unwrap();
        for (p, row) in PEOPLE.iter().zip(grants) {
            for (a, ans) in AGENTS.iter().zip(row) {
                if let Some(t) = ans.text() {
                    std::fs::write(d.join(format!("{p}__{a}")), t).unwrap();
                }
            }
        }
    }

    fn bot_config(id: &str, person: Option<&str>, agent: Option<&str>, cwd: &str) -> BotConfig {
        serde_json::from_value(json!({
            "id": id, "name": id, "backend": "claude", "cwd": cwd, "command": format!("{cwd}/run"),
            "hqAgent": agent, "person": person, "permission": "ask", "tasks": false, "connectors": [], "skills": [],
        }))
        .unwrap()
    }

    fn load(&self, sc: &Scenario) -> Ids {
        let n = self.case.get() + 1;
        self.case.set(n);
        self.write_grants(&sc.grants);
        let store = &self.hub.store;
        for (i, p) in PEOPLE.iter().enumerate() {
            store.delete_person(p).unwrap();
            if let Some(spec) = &sc.people[i] {
                store.put_person(p, p).unwrap();
                let agents = AGENTS
                    .iter()
                    .zip(spec.agents)
                    .filter(|(_, on)| *on)
                    .map(|(a, _)| ((*a).to_owned(), "member".to_owned()));
                store.set_person_agents(p, &agents.collect()).unwrap();
                let projects: Vec<String> =
                    PROJECTS.iter().zip(spec.projects).filter(|(_, on)| *on).map(|(p, _)| (*p).to_owned()).collect();
                store.set_person_projects(p, &projects).unwrap();
            }
        }
        let bots: Vec<String> = (0..sc.bots.len()).map(|i| format!("c{n}b{i}")).collect();
        for (id, b) in bots.iter().zip(&sc.bots) {
            let person = (b.owner > 0).then(|| PEOPLE[b.owner - 1]);
            let agent = (b.agent > 0).then(|| AGENTS[b.agent - 1]);
            store.save_bot(&Self::bot_config(id, person, agent, &format!("/Users/secret-{id}"))).unwrap();
        }
        let ghost = format!("c{n}ghost");
        let mut entries = Vec::new();
        for e in &sc.entries {
            let chat = bots.get(e.bot).unwrap_or(&ghost).clone();
            let author = match e.author {
                0 => None,
                1 => Some(json!(chat)),
                2 => Some(json!(bots[(e.bot + 1) % bots.len()])),
                _ => Some(json!(7)),
            };
            let mut data = json!({"options": [{"optionId": "allow"}]});
            if let Some(a) = author {
                data["author"] = a;
            }
            let kind = if e.permission { EntryKind::Permission } else { EntryKind::Notice };
            entries.push(store.insert_entry(&Lane::main(&chat), kind, 1, &data).unwrap().id);
        }
        // After the entries: deleting a bot deletes its lines.
        for (id, b) in bots.iter().zip(&sc.bots) {
            if b.deleted {
                store.delete_bot(id).unwrap();
            }
        }
        Ids { bots, ghost, entries }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        *TEST_BIN.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        TEST_ENV.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

fn agent_index(name: &str) -> Option<usize> {
    AGENTS.iter().position(|a| *a == name)
}

// ---- calls ----

/// Every method the router answers, read from the api sources the same way `roles_tests` does.
fn router_methods() -> Vec<String> {
    let sources = [
        include_str!("bots.rs"),
        include_str!("host.rs"),
        include_str!("folders.rs"),
        include_str!("backups.rs"),
        include_str!("kith_info.rs"),
        include_str!("marketplace.rs"),
        include_str!("remote.rs"),
        include_str!("people.rs"),
    ];
    let mut out = std::collections::BTreeSet::new();
    for src in sources {
        let mut open = false;
        for line in src.lines().map(str::trim) {
            let starts = line.starts_with('"') || (open && line.starts_with("| \""));
            if !starts {
                open = false;
                continue;
            }
            let head = line.split("=>").next().unwrap_or(line);
            let arm = line.contains("=>");
            if !arm && !head.trim_end().ends_with('|') {
                open = false;
                continue;
            }
            out.extend(
                head.split('"')
                    .skip(1)
                    .step_by(2)
                    .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric()))
                    .map(str::to_owned),
            );
            open = !arm;
        }
    }
    out.extend(crate::chat::memory::HQ_METHODS.iter().map(|m| (*m).to_owned()));
    out.insert("readFile".into());
    out.into_iter().collect()
}

#[derive(Clone, Debug)]
struct CallSpec {
    method: String,
    person: usize,
    proven: bool,
    bot: usize,
    entry: usize,
    folder: usize,
    clear: usize,
    project: usize,
}

fn call_spec(routed: Vec<String>) -> impl Strategy<Value = CallSpec> {
    let method = prop_oneof![
        6 => proptest::sample::select(MEMBER_METHODS.to_vec()).prop_map(str::to_owned),
        3 => proptest::sample::select(routed),
        1 => "[a-zA-Z]{0,8}",
        1 => Just("proveInvite".to_owned()),
    ];
    (method, 0..2usize, proptest::bool::weighted(0.85), 0..8usize, 0..6usize, 0..7usize, 0..6usize, 0..8usize).prop_map(
        |(method, person, proven, bot, entry, folder, clear, project)| CallSpec {
            method,
            person,
            proven,
            bot,
            entry,
            folder,
            clear,
            project,
        },
    )
}

impl CallSpec {
    fn body(&self, ids: &Ids) -> Value {
        let mut b = serde_json::Map::new();
        match self.bot {
            0..=3 => drop(b.insert("botId".into(), json!(ids.bots[self.bot]))),
            4 => drop(b.insert("botId".into(), json!(ids.ghost))),
            5 => drop(b.insert("botId".into(), json!(""))),
            6 => {}
            _ => drop(b.insert("botId".into(), json!(7))),
        }
        match self.entry {
            i if i < ids.entries.len() => drop(b.insert("entryId".into(), json!(ids.entries[i]))),
            3 => drop(b.insert("entryId".into(), json!("no-such-entry"))),
            4 => drop(b.insert("entryId".into(), json!(""))),
            _ => {}
        }
        match self.folder {
            0 => {}
            1 => drop(b.insert("folder".into(), json!(""))),
            2 => drop(b.insert("folder".into(), json!("   "))),
            3 => drop(b.insert("folder".into(), json!("/x"))),
            4 => drop(b.insert("folder".into(), Value::Null)),
            5 => drop(b.insert("folder".into(), json!(7))),
            _ => drop(b.insert("folder".into(), json!(" /x "))),
        }
        match self.clear {
            0 => {}
            1 => drop(b.insert("clear".into(), json!(true))),
            2 => drop(b.insert("clear".into(), json!(false))),
            3 => drop(b.insert("clear".into(), json!("true"))),
            4 => drop(b.insert("clear".into(), json!(1))),
            _ => drop(b.insert("clear".into(), Value::Null)),
        }
        let project = [
            None,
            Some(json!("")),
            Some(json!("  ")),
            Some(json!("pr1")),
            Some(json!("pr2")),
            Some(json!(" pr1 ")),
            Some(json!("other")),
            Some(json!(7)),
        ];
        if let Some(p) = &project[self.project] {
            b.insert("project".into(), p.clone());
        }
        Value::Object(b)
    }
}

/// Method names that name their chat through an entry, not a `botId`.
fn by_entry(m: &str) -> bool {
    matches!(m, "respondPermission" | "react" | "editHandoff" | "keepConversation")
}

fn nothing_to_check(m: &str) -> bool {
    matches!(m, "hello" | "projects" | "linkCode" | "startChat")
}

fn fail(msg: impl Into<String>) -> TestCaseError {
    TestCaseError::fail(msg.into())
}

/// Everything a successful `guard` from `person` must imply, stated from the scenario and not from `roles`.
fn check_guard_ok(w: &World, sc: &Scenario, c: &CallSpec, ids: &Ids, b: &Value) -> Result<(), TestCaseError> {
    let me = PEOPLE[c.person];
    let m = c.method.as_str();
    if !MEMBER_METHODS.contains(&m) {
        return Err(fail(format!("{m} is not on MEMBER_METHODS but guard let {me} through")));
    }
    if nothing_to_check(m) {
        return Ok(());
    }
    // The chat the call is about.
    let chat = if by_entry(m) {
        let entry = w.hub.store.entry(b["entryId"].as_str().unwrap_or_default());
        let Some(entry) = entry else { return Err(fail("guard let an unknown entry through")) };
        if m == "respondPermission" {
            if entry.kind != "permission" {
                return Err(fail("respondPermission let through for a card that is not a permission request"));
            }
            if let Some(a) = entry.data["author"].as_str()
                && a != entry.bot_id
            {
                return Err(fail("respondPermission let through for a card another bot raised"));
            }
            if entry.data["author"].as_str().is_none() && !entry.data["author"].is_null() {
                return Err(fail("respondPermission let through for a card with a non-string author"));
            }
        }
        entry.bot_id
    } else {
        b["botId"].as_str().unwrap_or_default().to_owned()
    };
    let row = w.hub.store.bot(&chat).unwrap().ok_or_else(|| fail("guard let through a chat that does not exist"))?;
    if row.deleted {
        return Err(fail("guard let through a deleted chat"));
    }
    if row.config.person.as_deref() != Some(me) {
        return Err(fail(format!("guard let {me} into a chat of {:?}", row.config.person)));
    }
    let Some(agent) = row.config.hq_agent.as_deref().and_then(agent_index) else {
        return Err(fail("guard let through a chat with no (known) agent"));
    };
    let ans = &sc.grants[c.person][agent];
    if !ans.allowed() {
        return Err(fail(format!("kith-auth says {ans:?} for {me}/{} and guard let through", AGENTS[agent])));
    }
    if m == "respondPermission" && !ans.member() {
        return Err(fail(format!("respondPermission let through for a non-member answer {ans:?}")));
    }
    if m == "send" {
        match Change::from_args(b) {
            Ok(Change::Nothing) => {}
            Ok(Change::Set(Pick::Project(p))) => {
                let shared = sc.people[c.person]
                    .as_ref()
                    .is_some_and(|s| PROJECTS.iter().zip(s.projects).any(|(x, on)| on && *x == p));
                if !shared {
                    return Err(fail(format!("send let {me} start in project {p} that is not shared with them")));
                }
            }
            other => return Err(fail(format!("send let through a folder pick: {b} -> {other:?}"))),
        }
    }
    let _ = ids;
    Ok(())
}

#[test]
fn guard_never_lets_a_person_past_their_grant() {
    let w = World::new();
    let routed = router_methods();
    assert!(routed.len() > 100, "router walk found {} methods", routed.len());
    runner()
        .run(&(scenario(), call_spec(routed)), |(sc, c)| {
            let ids = w.load(&sc);
            let b = c.body(&ids);
            let me = PEOPLE[c.person];
            let verdict = w.rt.block_on(roles::guard(&w.hub, me, c.proven, &c.method, &b));
            if !c.proven {
                // (2) A device that has not shown its invite may only show it.
                prop_assert_eq!(
                    verdict.is_ok(),
                    UNPROVEN_METHODS.contains(&c.method.as_str()),
                    "unproven {}",
                    c.method
                );
                if let Err(e) = &verdict {
                    prop_assert!(e.is::<NotAllowed>());
                }
                return Ok(());
            }
            match verdict {
                Ok(()) => {
                    check_guard_ok(&w, &sc, &c, &ids, &b)?;
                    // The same call after the grant is taken away must be refused (kith-auth is asked every call).
                    if !nothing_to_check(&c.method) {
                        let mut gone = sc.clone();
                        gone.grants[c.person] = [Ans::Denied(false), Ans::Denied(false)];
                        w.write_grants(&gone.grants);
                        let again = w.rt.block_on(roles::guard(&w.hub, me, true, &c.method, &b));
                        prop_assert!(again.is_err(), "{} still passes after the grant was removed", c.method);
                    }
                }
                Err(e) => {
                    if !MEMBER_METHODS.contains(&c.method.as_str()) {
                        prop_assert!(e.is::<NotAllowed>(), "{}: {e:#}", c.method);
                    }
                }
            }
            Ok(())
        })
        .unwrap();
}

/// Soundness alone passes a guard that refuses everything: these calls must get through.
#[test]
fn guard_lets_a_granted_member_use_their_own_chat() {
    let w = World::new();
    let sc = Scenario {
        grants: [[Ans::Member, Ans::Guest], [Ans::Denied(false), Ans::Denied(false)]],
        people: [Some(PersonSpec { agents: [true, true], projects: [true, false] }), None],
        bots: vec![
            BotSpec { owner: 1, deleted: false, agent: 1 },
            BotSpec { owner: 1, deleted: false, agent: 2 },
            BotSpec { owner: 2, deleted: false, agent: 1 },
            BotSpec { owner: 0, deleted: false, agent: 1 },
        ],
        entries: vec![
            EntrySpec { bot: 0, permission: true, author: 1 },
            EntrySpec { bot: 1, permission: true, author: 0 },
        ],
    };
    let ids = w.load(&sc);
    let go = |m: &str, b: Value| w.rt.block_on(roles::guard(&w.hub, "p1", true, m, &b));
    assert!(go("send", json!({"botId": ids.bots[0], "project": "pr1"})).is_ok());
    assert!(go("history", json!({"botId": ids.bots[1]})).is_ok());
    assert!(go("respondPermission", json!({"entryId": ids.entries[0]})).is_ok(), "a member answers their own prompt");
    assert!(go("respondPermission", json!({"entryId": ids.entries[1]})).is_err(), "a guest's prompt is the owner's");
    assert!(go("send", json!({"botId": ids.bots[2]})).is_err(), "another person's chat");
    assert!(go("send", json!({"botId": ids.bots[3]})).is_err(), "the owner's chat");
    assert!(go("send", json!({"botId": ids.bots[0], "project": "pr2"})).is_err());
    assert!(go("send", json!({"botId": ids.bots[0], "folder": "/x"})).is_err());
    assert!(go("send", json!({"botId": ids.bots[0], "clear": true})).is_err());
}

/// (7) kith-auth's answer, every kind: only a grant counts, anything unreadable is a no, a member alone approves.
#[test]
fn kith_auth_answers_fail_closed() {
    let w = World::new();
    let mut all =
        vec![Ans::Fail, Ans::Denied(false), Ans::Denied(true), Ans::Member, Ans::Guest, Ans::NoPreset, Ans::OwnerTrue];
    all.extend((0..GARBAGE.len()).map(Ans::Garbage));
    all.extend((0..OTHER_PRESETS.len()).map(Ans::Other));
    for a in all {
        w.write_grants(&[[a.clone(), Ans::Fail], [Ans::Fail, Ans::Fail]]);
        let (may, approves) =
            w.rt.block_on(async { (roles::may_use("p1", "a1").await, roles::approves_own("p1", "a1").await) });
        assert_eq!(may, a.allowed(), "may_use for {a:?}");
        assert_eq!(approves, a.member(), "approves_own for {a:?}");
        // An agent or person the table doesn't list is a failure of kith-auth: denied.
        assert!(!w.rt.block_on(roles::may_use("p1", "a2")));
        assert!(!w.rt.block_on(roles::may_use("nobody", "a1")));
        // And the agents list never offers more than kith-auth allows, nor calls a non-member a member.
        let case = Scenario {
            grants: [[a.clone(), Ans::Fail], [Ans::Fail, Ans::Fail]],
            people: [None, None],
            bots: vec![BotSpec { owner: 0, deleted: false, agent: 1 }, BotSpec { owner: 0, deleted: false, agent: 2 }],
            entries: vec![],
        };
        w.load(&case);
        let listed = w.rt.block_on(roles::granted_agents(&w.hub, "p1"));
        assert!(
            listed.iter().all(|r| r["agent"] == "a1" && a.allowed() && ((r["role"] == "member") == a.member())),
            "{a:?}: {listed:?}"
        );
        assert_eq!(listed.len(), usize::from(a.allowed()), "{a:?}");
    }
}

// ---- events ----

#[derive(Clone, Debug)]
struct EventSpec {
    kind: usize,
    bot: usize,
    key: usize,
    entry_kind: usize,
    who: usize,
}

const EVENT_TYPES: [&str; 9] = ["bot", "entry", "usage", "screens", "cloud", "resync", "terminal", "", "zzz"];

fn event_spec() -> impl Strategy<Value = EventSpec> {
    (0..EVENT_TYPES.len(), 0..=BOTS, 0..3usize, 0..2usize, 0..3usize)
        .prop_map(|(kind, bot, key, entry_kind, who)| EventSpec { kind, bot, key, entry_kind, who })
}

/// Everything in an event about a chat that a person must not see, tagged so a leak shows up in the text.
const SECRET: &str = "SECRET-PATH";

fn event_value(e: &EventSpec, ids: &Ids, hub: &Hub) -> Value {
    let chat = ids.bots.get(e.bot).unwrap_or(&ids.ghost).clone();
    let kind = if e.entry_kind == 0 { "permission" } else { "notice" };
    match EVENT_TYPES[e.kind] {
        "bot" => {
            let mut bot = match hub.store.bot(&chat).unwrap() {
                Some(row) => hub.bot_json(&row),
                None => json!({"id": chat}),
            };
            bot["id"] = json!(chat);
            for k in ["cwd", "command", "folder"] {
                bot[k] = json!(SECRET);
            }
            json!({"type": "bot", "bot": bot})
        }
        "entry" => {
            let mut entry = json!({"kind": kind, "text": "hi"});
            match e.key {
                0 => entry["botId"] = json!(chat),
                1 => entry["bot_id"] = json!(chat),
                _ => {
                    entry["botId"] = json!(7);
                    entry["bot_id"] = json!(chat);
                }
            }
            json!({"type": "entry", "entry": entry})
        }
        t => json!({"type": t, "rev": 1}),
    }
}

#[test]
fn events_reach_only_the_person_they_are_about() {
    let w = World::new();
    runner()
        .run(&(scenario(), event_spec()), |(sc, e)| {
            let ids = w.load(&sc);
            let ev = event_value(&e, &ids, &w.hub);
            let who = [None, Some("p1"), Some("p2")][e.who];
            let out = roles::event_for(&w.hub.store, who, ev.clone());
            let ty = EVENT_TYPES[e.kind];
            let chat = ids.bots.get(e.bot).unwrap_or(&ids.ghost);
            // The chat an entry event is about is `botId`, else `bot_id` (what the code reads; a non-string `botId` falls through).
            let about = if ty == "bot" {
                Some(chat.as_str())
            } else if ty == "entry" {
                Some(chat.as_str())
            } else {
                None
            };
            let row = about.and_then(|c| w.hub.store.bot(c).unwrap());
            match (who, out) {
                (Some(p), Some(v)) => {
                    // (5) A person's event is about their own chat, of an agent the host still lists for them.
                    prop_assert!(["bot", "entry", "resync"].contains(&ty), "{ty} reached {p}");
                    if ty != "resync" {
                        let row = row.ok_or_else(|| fail("event about an unknown chat reached a person"))?;
                        prop_assert_eq!(row.config.person.as_deref(), Some(p));
                        let i = PEOPLE.iter().position(|x| *x == p).unwrap();
                        let listed = sc.people[i].as_ref().is_some_and(|s| {
                            row.config.hq_agent.as_deref().and_then(agent_index).is_some_and(|a| s.agents[a])
                        });
                        prop_assert!(listed, "event about a chat whose agent is not granted reached {p}");
                        // (6) and nothing of where the agent works.
                        prop_assert!(!v.to_string().contains(SECRET), "{v}");
                        prop_assert!(!v.to_string().contains("/Users/secret-"), "{v}");
                    }
                }
                (Some(_), None) => {}
                (None, Some(v)) => {
                    // The owner sees an invitee's chat only as a permission prompt.
                    if let Some(row) = &row
                        && row.config.person.is_some()
                    {
                        prop_assert!(
                            ty == "entry" && v["entry"]["kind"] == "permission",
                            "{ty} about an invitee's chat reached the owner"
                        );
                    }
                }
                (None, None) => {
                    if let Some(row) = &row {
                        prop_assert!(row.config.person.is_some(), "an owner event was dropped for the owner");
                    }
                }
            }
            Ok(())
        })
        .unwrap();
}

// ---- shaping ----

fn junk() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![Just(Value::Null), any::<bool>().prop_map(Value::from), "[a-z/]{0,6}".prop_map(Value::from)];
    leaf.prop_recursive(2, 8, 3, |inner| {
        prop_oneof![
            proptest::collection::vec(inner.clone(), 0..3).prop_map(Value::Array),
            proptest::collection::hash_map("[a-z]{1,4}|cwd|command|folder|path|error|options", inner, 0..4)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn with_secrets(v: Value, keys: &[&str]) -> Value {
    let mut o = match v {
        Value::Object(o) => o,
        _ => serde_json::Map::new(),
    };
    for k in keys {
        o.insert((*k).to_owned(), json!(SECRET));
    }
    Value::Object(o)
}

#[test]
fn what_a_person_is_shown_has_no_paths_folders_or_error_text() {
    let w = World::new();
    let sc = Scenario {
        grants: [[Ans::Fail, Ans::Fail], [Ans::Fail, Ans::Fail]],
        people: [Some(PersonSpec { agents: [false, false], projects: [true, false] }), None],
        bots: vec![],
        entries: vec![],
    };
    w.load(&sc);
    let listed = |v: &Value| v.as_array().cloned().unwrap_or_default();
    runner()
        .run(&(junk(), junk(), proptest::collection::vec((junk(), 0..3usize), 0..4)), |(base, bot, projects)| {
            // hello: only the allowed names survive.
            let hello =
                roles::shape(&w.hub, "p1", "hello", with_secrets(base.clone(), &["cwd", "addr", "screens", "path"]));
            let keep = ["hostId", "computerId", "signKey", "boxKey", "name", "version", "minApp", "os", "rev"];
            prop_assert!(hello.as_object().is_none_or(|o| o.keys().all(|k| keep.contains(&k.as_str()))), "{hello}");
            // history / thread: not the folder.
            for m in ["history", "thread"] {
                let v = roles::shape(&w.hub, "p1", m, with_secrets(base.clone(), &["folder"]));
                prop_assert!(v.get("folder").is_none(), "{m}: {v}");
            }
            // projects: shared ones only, an id and a name, no error text.
            let list: Vec<Value> = projects
                .iter()
                .map(|(extra, i)| {
                    let mut p = with_secrets(extra.clone(), &["path", "folders", "cwd"]);
                    p["id"] = json!(["pr1", "pr2", "pr3"][*i]);
                    p
                })
                .collect();
            let v = roles::shape(&w.hub, "p1", "projects", json!({"projects": list, "error": SECRET}));
            prop_assert!(v.get("error").is_none());
            for p in listed(&v["projects"]) {
                prop_assert_eq!(p["id"].as_str(), Some("pr1"));
                prop_assert_eq!(p.as_object().map(|o| o.len()), Some(2));
                prop_assert!(!p.to_string().contains(SECRET));
            }
            // kithInfo: a name, description and avatar and when it was fetched.
            let info = roles::shape(
                &w.hub,
                "p1",
                "kithInfo",
                json!({"info": with_secrets(base.clone(), &["cwd", "name", "path"]), "fetchedAt": 1, "path": SECRET}),
            );
            prop_assert!(info.as_object().unwrap().keys().all(|k| k == "info" || k == "fetchedAt"), "{info}");
            prop_assert!(
                info["info"]
                    .as_object()
                    .is_none_or(|o| o.keys().all(|k| ["name", "description", "avatar"].contains(&k.as_str())))
            );
            // shape_bot and hello_for.
            let b = roles::shape_bot(json!({"type": "bot", "bot": with_secrets(bot, &["cwd", "command", "folder"])}));
            for k in ["cwd", "command", "folder"] {
                prop_assert!(b["bot"].get(k).is_none(), "{k} left in {b}");
            }
            let h = roles::hello_for(&with_secrets(base, &["cwd", "path", "signKey"]));
            prop_assert!(
                h.as_object().unwrap().keys().all(|k| ["type", "hostId", "computerId", "rev"].contains(&k.as_str())),
                "{h}"
            );
            Ok(())
        })
        .unwrap();
}

/// The bot as the host really sends it (`bot_json`) shows no place on this computer once shaped.
#[test]
fn a_real_bot_json_loses_where_it_works() {
    let w = World::new();
    let sc = Scenario {
        grants: [[Ans::Member, Ans::Fail], [Ans::Fail, Ans::Fail]],
        people: [Some(PersonSpec { agents: [true, false], projects: [false, false] }), None],
        bots: vec![BotSpec { owner: 1, deleted: false, agent: 1 }],
        entries: vec![],
    };
    let ids = w.load(&sc);
    let row = w.hub.store.bot(&ids.bots[0]).unwrap().unwrap();
    let ev = json!({"type": "bot", "bot": w.hub.bot_json(&row)});
    assert!(ev.to_string().contains("/Users/secret-"), "the fixture must carry a path or this checks nothing");
    let seen = roles::event_for(&w.hub.store, Some("p1"), ev).expect("their own chat reaches them");
    assert!(!seen.to_string().contains("/Users/secret-"), "{seen}");
}
