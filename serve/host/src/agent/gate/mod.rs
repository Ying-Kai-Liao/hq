//! The resource gate: at most `max_running_agents` agent turns at once, and none starts while memory is short.
//!
//! A slot is a turn in flight, not a warm process. Every bot actor asks for one before it starts a turn of any
//! kind (a message, a routine, a room turn, a bot request, a compaction) and holds the [`Permit`] until the
//! turn ends; dropping the permit gives the slot back, so no path out of a turn can leak one. Waiting actors are
//! served in the order they began waiting, across bots. A bot with turns queued has one entry here, not one per
//! message.
//!
//! A turn blocked on another bot's reply parks its slot ([`Gate::park`]) so the bot it waits on can take it:
//! with one slot, a bot asking another would otherwise hold the only slot while the answer waits for one.
//!
//! When memory is what blocks the head of the line, the host first stops agents that are at rest (nothing
//! running or queued, sessions it can load again), longest idle first, and only then lets turns wait.

pub mod memory;
mod settings;

use crate::LockExt;
use crate::hub::Hub;
use memory::{Memory, Probe};
use serde_json::{Value, json};
pub use settings::Settings;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::{Notify, oneshot};

/// What a waiting bot's runtime activity starts with (the apps show it as the bot's working line).
pub const WAITING: &str = "Waiting for room";

/// How often a waiting turn looks at memory again when nothing else woke it.
const RECHECK: Duration = Duration::from_secs(5);
/// After an agent was stopped to make room, memory needs a moment to come back.
const SETTLE: Duration = Duration::from_millis(1500);

const ACTIVE: u8 = 0;
const PARKED: u8 = 1;
const DEAD: u8 = 2;

/// One turn's hold on a slot. The slot is counted from admission until this is dropped.
struct Slot(AtomicU8);

impl Slot {
    /// Counts a parked slot again. Does nothing for a slot that is active, or whose turn is over.
    fn activate(&self, gate: &Gate) {
        if self.0.compare_exchange(PARKED, ACTIVE, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            gate.running.fetch_add(1, Ordering::AcqRel);
        }
    }
}

#[must_use = "the slot is given back when the permit is dropped"]
pub struct Permit {
    gate: Arc<Gate>,
    slot: Arc<Slot>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        if self.slot.0.swap(DEAD, Ordering::AcqRel) == ACTIVE {
            self.gate.running.fetch_sub(1, Ordering::AcqRel);
        }
        self.gate.wake.notify_one();
    }
}

enum Grant {
    Turn(oneshot::Sender<Permit>),
    /// A parked turn getting its slot back.
    Resume(Arc<Slot>, oneshot::Sender<()>),
}

struct Waiter {
    id: u64,
    /// The actor waiting (see `agent::bot::actor_key`).
    rt: String,
    grant: Grant,
}

impl Waiter {
    fn closed(&self) -> bool {
        match &self.grant {
            Grant::Turn(tx) => tx.is_closed(),
            Grant::Resume(_, tx) => tx.is_closed(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Blocked {
    Slots,
    /// Why memory is short, as the waiting line shows it ("memory 18% free").
    Memory(String),
}

#[derive(Default)]
struct State {
    waiters: VecDeque<Waiter>,
    next_id: u64,
    blocked: Option<Blocked>,
    /// Actor key -> its turn's slot, for [`Gate::park`].
    slots: HashMap<String, Weak<Slot>>,
    last_memory: Option<Memory>,
}

pub struct Gate {
    pub settings: Settings,
    probe: Box<dyn Probe>,
    running: AtomicUsize,
    state: Mutex<State>,
    wake: Notify,
    probe_warned: AtomicBool,
}

impl Gate {
    pub fn new(settings: Settings, probe: Box<dyn Probe>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            probe,
            running: AtomicUsize::new(0),
            state: Mutex::default(),
            wake: Notify::new(),
            probe_warned: AtomicBool::new(false),
        })
    }

    /// Joins the line for a slot. A bot calls this when it has a turn to start and holds the result until it
    /// is granted or no longer wants the turn; dropping it leaves the line.
    pub fn enter(self: &Arc<Self>, rt: &str) -> Admission {
        let (tx, rx) = oneshot::channel();
        let id = self.enqueue(rt, Grant::Turn(tx), false);
        self.pump();
        Admission { id, gate: self.clone(), rx }
    }

    fn enqueue(&self, rt: &str, grant: Grant, front: bool) -> u64 {
        let mut st = self.state.locked();
        st.next_id += 1;
        let waiter = Waiter { id: st.next_id, rt: rt.to_owned(), grant };
        let id = waiter.id;
        if front {
            st.waiters.push_front(waiter);
        } else {
            st.waiters.push_back(waiter);
        }
        id
    }

    fn leave(&self, id: u64) {
        self.state.locked().waiters.retain(|w| w.id != id);
        self.wake.notify_one();
    }

    /// Admits waiters from the front for as long as there are slots and memory. Cheap enough to run on
    /// every change: the memory probe is only read when a slot is free for the head of the line.
    fn pump(self: &Arc<Self>) {
        let mut st = self.state.locked();
        st.waiters.retain(|w| !w.closed());
        loop {
            if st.waiters.is_empty() {
                st.blocked = None;
                return;
            }
            if self.running.load(Ordering::Acquire) >= self.settings.max_running {
                st.blocked = Some(Blocked::Slots);
                return;
            }
            if let Some(why) = self.shortage(&mut st) {
                let was_memory = matches!(st.blocked, Some(Blocked::Memory(_)));
                st.blocked = Some(Blocked::Memory(why));
                drop(st);
                // Memory just became the blocker: the task may stop idle agents to make room. Not on every
                // pump, or the task's own pump would wake it again.
                if !was_memory {
                    self.wake.notify_one();
                }
                return;
            }
            let Some(waiter) = st.waiters.pop_front() else { return };
            match waiter.grant {
                Grant::Turn(tx) => {
                    self.running.fetch_add(1, Ordering::AcqRel);
                    let slot = Arc::new(Slot(AtomicU8::new(ACTIVE)));
                    st.slots.retain(|_, s| s.strong_count() > 0);
                    st.slots.insert(waiter.rt, Arc::downgrade(&slot));
                    // A receiver that is gone drops the permit, which gives the slot straight back.
                    drop(tx.send(Permit { gate: self.clone(), slot }));
                }
                Grant::Resume(slot, tx) => {
                    slot.activate(self);
                    let _ = tx.send(());
                }
            }
        }
    }

    fn shortage(&self, st: &mut State) -> Option<String> {
        if self.settings.min_free_percent <= 0.0 && self.settings.max_swap_gb <= 0.0 {
            return None;
        }
        match self.probe.read() {
            Ok(memory) => {
                st.last_memory = Some(memory);
                self.settings.shortage(&memory)
            }
            Err(error) => {
                // Unknown counts as room: a host that can't measure must still work.
                if !self.probe_warned.swap(true, Ordering::Relaxed) {
                    tracing::warn!(error = format!("{error:#}"), "can't read memory; not holding turns back for it");
                }
                None
            }
        }
    }

    fn memory_blocked(&self) -> bool {
        matches!(self.state.locked().blocked, Some(Blocked::Memory(_)))
    }

    /// The line a waiting bot shows.
    pub fn waiting_text(&self) -> String {
        let blocked = self.state.locked().blocked.clone();
        if let Some(Blocked::Memory(why)) = blocked {
            format!("{WAITING} ({why})")
        } else {
            let n = self.running.load(Ordering::Acquire);
            format!("{WAITING} ({n} agent{} running)", if n == 1 { "" } else { "s" })
        }
    }

    /// Who waits for a new turn and what each should show.
    fn waiting_lines(&self) -> Vec<(String, String)> {
        let text = self.waiting_text();
        let st = self.state.locked();
        st.waiters.iter().filter(|w| matches!(w.grant, Grant::Turn(_))).map(|w| (w.rt.clone(), text.clone())).collect()
    }

    /// Gate state for `/health`.
    pub fn status(&self) -> Value {
        let (waiting, blocked, last) = {
            let st = self.state.locked();
            let blocked = match &st.blocked {
                None => Value::Null,
                Some(Blocked::Slots) => json!("slots"),
                Some(Blocked::Memory(_)) => json!("memory"),
            };
            (st.waiters.len(), blocked, st.last_memory)
        };
        // A reading of its own, so an idle host reports its memory too.
        let memory = self.probe.read().ok().or(last);
        json!({
            "running": self.running.load(Ordering::Acquire),
            "waiting": waiting,
            "blocked": blocked,
            "maxRunning": self.settings.max_running,
            "minFreeMemoryPercent": self.settings.min_free_percent,
            "maxSwapUsedGb": self.settings.max_swap_gb,
            "idleShutdownMinutes": self.settings.idle_shutdown.as_secs() / 60,
            "memory": memory.map(|m| json!({"freePercent": m.free_percent.round(), "swapUsedGb": (m.swap_used_gb * 100.0).round() / 100.0})),
        })
    }

    /// Gives up `rt`'s slot while its turn waits on another bot's reply. Resume with [`Parked::resume`] before
    /// the answer reaches the agent. Nothing is parked when `rt` has no turn holding a slot.
    pub fn park(self: &Arc<Self>, rt: &str) -> Parked {
        let slot = self
            .state
            .locked()
            .slots
            .get(rt)
            .and_then(Weak::upgrade)
            .filter(|slot| slot.0.compare_exchange(ACTIVE, PARKED, Ordering::AcqRel, Ordering::Acquire).is_ok());
        if slot.is_some() {
            self.running.fetch_sub(1, Ordering::AcqRel);
            self.wake.notify_one();
        }
        Parked { gate: self.clone(), rt: rt.to_owned(), slot, waiting: None }
    }
}

/// A place in line for a slot.
pub struct Admission {
    id: u64,
    gate: Arc<Gate>,
    rx: oneshot::Receiver<Permit>,
}

impl Admission {
    /// The permit, if it was granted already.
    pub fn try_take(&mut self) -> Option<Permit> {
        self.rx.try_recv().ok()
    }

    /// Resolves when the slot is granted; cancel safe.
    pub async fn granted(&mut self) -> Permit {
        match (&mut self.rx).await {
            Ok(permit) => permit,
            // The gate keeps its senders until it is gone.
            Err(_) => std::future::pending().await,
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.gate.leave(self.id);
    }
}

/// A turn's slot given up while it waits for another bot.
pub struct Parked {
    gate: Arc<Gate>,
    rt: String,
    slot: Option<Arc<Slot>>,
    waiting: Option<u64>,
}

impl Parked {
    /// Waits for a slot again, ahead of turns that haven't started: this one is already part way through.
    pub async fn resume(mut self) {
        // A turn that ended while parked has nothing to come back to.
        let Some(slot) = self.slot.clone().filter(|s| s.0.load(Ordering::Acquire) == PARKED) else { return };
        let (tx, rx) = oneshot::channel();
        self.waiting = Some(self.gate.enqueue(&self.rt, Grant::Resume(slot, tx), true));
        self.gate.pump();
        let _ = rx.await;
    }
}

impl Drop for Parked {
    fn drop(&mut self) {
        if let Some(id) = self.waiting {
            self.gate.leave(id);
        }
        // Dropped before it got its slot back (the call was cancelled): count the turn again anyway, so the
        // slot is not lost for the rest of the turn.
        if let Some(slot) = &self.slot {
            slot.activate(&self.gate);
        }
    }
}

/// Keeps waiting turns moving: re-checks memory every few seconds and whenever a slot is released, stops idle
/// agents when memory is what holds the line, and keeps the waiting bots' status line current.
pub async fn run(gate: Arc<Gate>, hub: Weak<Hub>) {
    loop {
        tokio::select! {
            () = gate.wake.notified() => {}
            () = tokio::time::sleep(RECHECK) => {}
        }
        let Some(hub) = hub.upgrade() else { return };
        gate.pump();
        while gate.memory_blocked() && hub.reclaim_idle_agent().await {
            tokio::time::sleep(SETTLE).await;
            gate.pump();
        }
        for (rt, text) in gate.waiting_lines() {
            hub.set_runtime(&rt, |r| {
                if r.status == crate::hub::BotStatus::Working && r.activity.starts_with(WAITING) && r.activity != text {
                    r.activity = text;
                }
            });
        }
    }
}

#[cfg(test)]
mod tests;
