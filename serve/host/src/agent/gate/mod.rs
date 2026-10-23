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
//! The owner's turns go ahead of invited people's, and invited people together hold at most [`INVITEE_SLOTS`] of the
//! running slots: someone else's chat never keeps the owner's own agents waiting.
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

/// How many slots invited people's turns may hold together.
pub const INVITEE_SLOTS: usize = 1;

const ACTIVE: u8 = 0;
const PARKED: u8 = 1;
const DEAD: u8 = 2;

/// One turn's hold on a slot. The slot is counted from admission until this is dropped.
struct Slot {
    /// An invited person's turn: counted against [`INVITEE_SLOTS`] while it is active.
    invitee: bool,
    state: AtomicU8,
    /// Asks of other bots this turn is waiting on right now; the slot is parked while there are any.
    asks: AtomicUsize,
}

impl Slot {
    /// Counts a parked slot again. Does nothing for a slot that is active, or whose turn is over.
    fn activate(&self, gate: &Gate) {
        if self.state.compare_exchange(PARKED, ACTIVE, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            gate.running.fetch_add(1, Ordering::AcqRel);
            if self.invitee {
                gate.invitees.fetch_add(1, Ordering::AcqRel);
            }
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
        if self.slot.state.swap(DEAD, Ordering::AcqRel) == ACTIVE {
            self.gate.running.fetch_sub(1, Ordering::AcqRel);
            if self.slot.invitee {
                self.gate.invitees.fetch_sub(1, Ordering::AcqRel);
            }
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
    /// A new turn of an invited person: behind every other waiter.
    low: bool,
    /// Takes one of the invited people's slots when granted (a new turn of theirs, or one of theirs coming back).
    needs_invitee_slot: bool,
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
    /// How many of the active slots are invited people's.
    invitees: AtomicUsize,
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
            invitees: AtomicUsize::new(0),
            state: Mutex::default(),
            wake: Notify::new(),
            probe_warned: AtomicBool::new(false),
        })
    }

    /// Joins the line for a slot. A bot calls this when it has a turn to start and holds the result until it
    /// is granted or no longer wants the turn; dropping it leaves the line.
    pub fn enter(self: &Arc<Self>, rt: &str) -> Admission {
        self.enter_as(rt, false)
    }

    /// [`Gate::enter`] for a turn of an invited person (`invitee`): it waits behind the owner's turns and holds one of
    /// the few slots invited people share.
    pub fn enter_as(self: &Arc<Self>, rt: &str, invitee: bool) -> Admission {
        let (tx, rx) = oneshot::channel();
        let id = self.enqueue(rt, Grant::Turn(tx), false, invitee);
        self.pump();
        Admission { id, gate: self.clone(), rx }
    }

    /// `invitee`: the turn (or the parked turn coming back) is an invited person's.
    fn enqueue(&self, rt: &str, grant: Grant, front: bool, invitee: bool) -> u64 {
        let mut st = self.state.locked();
        st.next_id += 1;
        let low = invitee && matches!(grant, Grant::Turn(_));
        let waiter = Waiter { id: st.next_id, rt: rt.to_owned(), grant, low, needs_invitee_slot: invitee };
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
            // Who is next: the first waiter that isn't an invited person's new turn, else the first of those. Anyone
            // who needs an invited person's slot waits while those are taken.
            let invitee_open = self.invitees.load(Ordering::Acquire) < INVITEE_SLOTS;
            let may = |w: &Waiter| invitee_open || !w.needs_invitee_slot;
            let next = st
                .waiters
                .iter()
                .position(|w| !w.low && may(w))
                .or_else(|| st.waiters.iter().position(|w| w.low && may(w)));
            let Some(next) = next else {
                st.blocked = Some(Blocked::Slots);
                return;
            };
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
            let Some(waiter) = st.waiters.remove(next) else { return };
            match waiter.grant {
                Grant::Turn(tx) => {
                    self.running.fetch_add(1, Ordering::AcqRel);
                    if waiter.needs_invitee_slot {
                        self.invitees.fetch_add(1, Ordering::AcqRel);
                    }
                    let slot = Arc::new(Slot {
                        invitee: waiter.needs_invitee_slot,
                        state: AtomicU8::new(ACTIVE),
                        asks: AtomicUsize::new(0),
                    });
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
        let slot = self.state.locked().slots.get(rt).and_then(Weak::upgrade);
        // Asks that run side by side share one parking: the first gives the slot up, the last takes it back.
        if let Some(slot) = &slot
            && slot.asks.fetch_add(1, Ordering::AcqRel) == 0
            && slot.state.compare_exchange(ACTIVE, PARKED, Ordering::AcqRel, Ordering::Acquire).is_ok()
        {
            self.running.fetch_sub(1, Ordering::AcqRel);
            if slot.invitee {
                self.invitees.fetch_sub(1, Ordering::AcqRel);
            }
            self.wake.notify_one();
        }
        Parked { gate: self.clone(), rt: rt.to_owned(), counted: slot.is_some(), last: false, slot, waiting: None }
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
    /// This ask still counts among the turn's outstanding ones.
    counted: bool,
    /// It was the last outstanding ask, so it is the one that takes the slot back.
    last: bool,
    waiting: Option<u64>,
}

impl Parked {
    /// Waits for a slot again, ahead of turns that haven't started: this one is already part way through.
    pub async fn resume(mut self) {
        // Other asks of the same turn are still out: the slot stays given up until the last one is back.
        if !self.end_ask() {
            return;
        }
        // A turn that ended while parked has nothing to come back to.
        let Some(slot) = self.slot.clone().filter(|s| s.state.load(Ordering::Acquire) == PARKED) else { return };
        let (tx, rx) = oneshot::channel();
        let invitee = slot.invitee;
        self.waiting = Some(self.gate.enqueue(&self.rt, Grant::Resume(slot, tx), true, invitee));
        self.gate.pump();
        let _ = rx.await;
    }

    /// This ask is over. Whether it was the turn's last outstanding one.
    fn end_ask(&mut self) -> bool {
        if let (true, Some(slot)) = (self.counted, &self.slot) {
            self.counted = false;
            self.last = slot.asks.fetch_sub(1, Ordering::AcqRel) == 1;
        }
        self.last
    }
}

impl Drop for Parked {
    fn drop(&mut self) {
        if let Some(id) = self.waiting {
            self.gate.leave(id);
        }
        // Dropped before it got its slot back (the call was cancelled): count the turn again anyway, so the
        // slot is not lost for the rest of the turn.
        if self.end_ask()
            && let Some(slot) = &self.slot
        {
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
