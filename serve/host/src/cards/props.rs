//! Property tests for the card store: random sequences of asks, answers, parks, withdrawals, sweeps and restarts, with
//! the invariants of the design checked after every step (A1, A4, A6, A7, C3, C8). Every property calls the real
//! `Store`; nothing here models it. Run only these: `cargo test --bin kith cards::props`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::store::{Answered, Card, CardState, NewCard, Opened, Store};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use std::collections::HashMap;

const SESSIONS: [&str; 2] = ["s1", "s2"];
const RESOURCES: [&str; 2] = ["Bash:ls", "Write:/tmp/a"];
const PEOPLE: [&str; 2] = ["sam", ""];

#[derive(Debug, Clone)]
enum Op {
    Ask { session: usize, resource: usize, person: usize },
    Answer { pick: usize, allow: bool, late: bool },
    ParkRun,
    Withdraw { person: usize },
    Sweep { far: bool },
    Restart,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (0..2usize, 0..2usize, 0..2usize).prop_map(|(session, resource, person)| Op::Ask { session, resource, person }),
        4 => (0..16usize, any::<bool>(), any::<bool>()).prop_map(|(pick, allow, late)| Op::Answer { pick, allow, late }),
        1 => Just(Op::ParkRun),
        1 => (0..2usize).prop_map(|person| Op::Withdraw { person }),
        1 => any::<bool>().prop_map(|far| Op::Sweep { far }),
        1 => Just(Op::Restart),
    ]
}

fn store() -> Store {
    let dir = std::env::temp_dir().join(format!("kith-cards-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Store::open(&dir.join("t.db")).unwrap()
}

fn ask(session: usize, resource: usize, person: usize) -> NewCard {
    NewCard {
        session: SESSIONS[session].into(),
        source: "run",
        bot_id: None,
        run_id: Some("r".into()),
        person: PEOPLE[person].into(),
        agent: "echo".into(),
        approver: "owner",
        tool: "Bash".into(),
        input: "{}".into(),
        resource: RESOURCES[resource].into(),
        shown: RESOURCES[resource].into(),
        deadline: 1_000,
    }
}

/// Whether the card design lets `from` become `to`; `used` and the closed states never come back.
fn legal(from: CardState, to: CardState) -> bool {
    use CardState::*;
    from == to
        || matches!(
            (from, to),
            (Pending, Live | Parked | Approved | Denied | Expired | Withdrawn)
                | (Live, Parked | Approved | Denied | Expired | Withdrawn)
                | (Parked, Live | Approved | Denied | Expired | Withdrawn)
                | (Approved, Used | Expired | Withdrawn)
        )
}

struct World {
    s: Store,
    ids: Vec<String>,
    seen: HashMap<String, CardState>,
    /// per (session, resource): yes answers recorded, and grants taken by an ask
    yes: HashMap<(String, String), usize>,
    taken: HashMap<(String, String), usize>,
    now: i64,
}

impl World {
    fn new() -> Self {
        Self { s: store(), ids: Vec::new(), seen: HashMap::new(), yes: HashMap::new(), taken: HashMap::new(), now: 100 }
    }

    fn cards(&self) -> Vec<Card> {
        self.ids.iter().filter_map(|id| self.s.card(id)).collect()
    }

    fn step(&mut self, op: &Op) {
        self.now += 1;
        match op {
            Op::Ask { session, resource, person } => {
                let n = ask(*session, *resource, *person);
                match self.s.card_open(&n, self.now).unwrap() {
                    Opened::New(c) => {
                        self.ids.push(c.id.clone());
                        self.s.card_live(&c.id, Some("e"), Some("r")).unwrap();
                    }
                    Opened::Joined(_) => {}
                    Opened::Granted(c) => {
                        *self.taken.entry((c.session.clone(), c.resource.clone())).or_default() += 1;
                        assert_eq!(
                            (c.session.as_str(), c.resource.as_str()),
                            (n.session.as_str(), n.resource.as_str()),
                            "C8"
                        );
                    }
                }
            }
            Op::Answer { pick, allow, late } => {
                let Some(id) = self.ids.get(pick % self.ids.len().max(1)).cloned() else { return };
                let before = self.s.card(&id).unwrap();
                let at = if *late { 5_000 } else { self.now };
                let got = self.s.card_answer(&id, *allow, "x", "kai", at).unwrap();
                match got {
                    Answered::Applied { card, .. } => {
                        assert!(
                            before.state.open() && at <= before.deadline,
                            "A1: only an open card before its deadline answers"
                        );
                        if card.state == CardState::Approved {
                            *self.yes.entry((card.session.clone(), card.resource.clone())).or_default() += 1;
                        }
                    }
                    Answered::Nothing(_) => {
                        let after = self.s.card(&id).unwrap();
                        assert!(
                            !matches!(after.state, CardState::Approved) || before.state == CardState::Approved,
                            "A1"
                        );
                    }
                }
            }
            Op::ParkRun => {
                self.s.cards_park_run("r").unwrap();
            }
            Op::Withdraw { person } => {
                if !PEOPLE[*person].is_empty() {
                    self.s.cards_withdraw_person(PEOPLE[*person], None).unwrap();
                    // A7: nothing of theirs is open or an unused grant after.
                    for c in self.cards().iter().filter(|c| c.person == PEOPLE[*person]) {
                        assert!(!c.state.open() && c.state != CardState::Approved, "A7: {c:?}");
                    }
                }
            }
            Op::Sweep { far } => {
                let at = if *far { 10_000 } else { self.now };
                self.s.cards_sweep(at).unwrap();
                if *far {
                    self.now = 10_000;
                    for c in self.cards() {
                        assert!(!c.state.open() && c.state != CardState::Approved, "silence is no: {c:?}");
                    }
                }
            }
            Op::Restart => {
                self.s.cards_restart(self.now).unwrap();
                assert!(self.cards().iter().all(|c| !matches!(c.state, CardState::Live | CardState::Pending)), "C4");
            }
        }
    }

    fn check(&mut self) -> Result<(), TestCaseError> {
        let cards = self.cards();
        // A6: at most one open card per (session, resource).
        let mut open: HashMap<(String, String), usize> = HashMap::new();
        for c in cards.iter().filter(|c| c.state.open()) {
            *open.entry((c.session.clone(), c.resource.clone())).or_default() += 1;
        }
        prop_assert!(open.values().all(|n| *n == 1), "A6: {open:?}");
        for c in &cards {
            if let Some(was) = self.seen.insert(c.id.clone(), c.state) {
                prop_assert!(legal(was, c.state), "{was:?} -> {:?} for {}", c.state, c.id);
            }
            // Nothing is a grant unless a yes was recorded (A1, A3).
            if matches!(c.state, CardState::Approved | CardState::Used) {
                prop_assert!(c.allowed == Some(true) && c.granted_at.is_some(), "{c:?}");
            }
            if matches!(c.state, CardState::Denied | CardState::Expired | CardState::Withdrawn) {
                prop_assert!(c.state != CardState::Approved);
            }
        }
        // A4: a yes buys one use: grants taken by later asks never outnumber the yeses, per session and resource.
        for (k, n) in &self.taken {
            prop_assert!(
                *n <= self.yes.get(k).copied().unwrap_or(0),
                "A4: {k:?} used {n}, said yes {:?}",
                self.yes.get(k)
            );
        }
        Ok(())
    }
}

fn runner() -> TestRunner {
    let mut config = Config { failure_persistence: None, ..Config::default() };
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = 64;
    }
    TestRunner::new(config)
}

#[test]
fn the_card_invariants_hold_over_random_histories() {
    runner()
        .run(&proptest::collection::vec(op(), 1..40), |ops| {
            let mut w = World::new();
            for o in &ops {
                w.step(o);
                w.check()?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
        .unwrap();
}
