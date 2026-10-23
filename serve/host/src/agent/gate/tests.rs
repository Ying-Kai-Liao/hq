use super::*;
use std::sync::Mutex;

/// A memory reading the test sets; `None` is a probe that fails.
struct Fake(Arc<Mutex<Option<Memory>>>);

impl Probe for Fake {
    fn read(&self) -> anyhow::Result<Memory> {
        (*self.0.lock().unwrap()).ok_or_else(|| anyhow::anyhow!("no reading"))
    }
}

fn plenty() -> Memory {
    Memory { free_percent: 80.0, swap_used_gb: 0.0 }
}

fn gate(max_running: usize) -> (Arc<Gate>, Arc<Mutex<Option<Memory>>>) {
    let memory = Arc::new(Mutex::new(Some(plenty())));
    let settings = Settings { max_running, ..Settings::default() };
    (Gate::new(settings, Box::new(Fake(memory.clone()))), memory)
}

fn running(gate: &Gate) -> usize {
    gate.running.load(Ordering::Acquire)
}

#[test]
fn admits_up_to_the_limit_and_the_rest_wait_in_order() {
    let (gate, _) = gate(2);
    let mut a = gate.enter("a");
    let mut b = gate.enter("b");
    let mut c = gate.enter("c");
    let mut d = gate.enter("d");
    let pa = a.try_take().expect("a is admitted");
    let _pb = b.try_take().expect("b is admitted");
    assert!(c.try_take().is_none() && d.try_take().is_none());
    assert_eq!((running(&gate), gate.status()["waiting"].clone()), (2, json!(2)));
    assert_eq!(gate.waiting_text(), "Waiting for room (2 agents running)");

    drop(pa);
    gate.pump();
    assert!(c.try_take().is_some(), "the one who waited longest goes first");
    assert!(d.try_take().is_none());
}

#[test]
fn a_slot_comes_back_when_the_permit_is_dropped_however_the_turn_ended() {
    let (gate, _) = gate(1);
    let mut first = gate.enter("a");
    let permit = first.try_take().unwrap();
    assert_eq!(running(&gate), 1);
    drop(permit);
    assert_eq!(running(&gate), 0);

    // A permit granted to an admission nobody takes (the actor went away) is not leaked.
    let mut holder = gate.enter("a");
    let held = holder.try_take().unwrap();
    let late = gate.enter("b");
    drop(held);
    gate.pump();
    drop(late);
    assert_eq!(running(&gate), 0);
    assert_eq!(gate.status()["waiting"], 0);

    // Giving up the line never costs a slot, and the next in line still gets in.
    let mut holder = gate.enter("a");
    let held = holder.try_take().unwrap();
    let gone = gate.enter("b");
    let mut next = gate.enter("c");
    drop(gone);
    drop(held);
    gate.pump();
    let _taken = next.try_take().expect("the next in line still gets in");
    assert_eq!(running(&gate), 1);
}

#[test]
fn short_memory_holds_the_line_even_with_a_free_slot() {
    let (gate, memory) = gate(2);
    *memory.lock().unwrap() = Some(Memory { free_percent: 18.0, swap_used_gb: 0.5 });
    let mut a = gate.enter("a");
    assert!(a.try_take().is_none());
    assert_eq!(running(&gate), 0);
    assert_eq!(gate.waiting_text(), "Waiting for room (memory 18% free)");
    assert_eq!(gate.status()["blocked"], "memory");

    *memory.lock().unwrap() = Some(Memory { free_percent: 60.0, swap_used_gb: 4.0 });
    gate.pump();
    assert_eq!(gate.waiting_text(), "Waiting for room (swap 4.0 GB used)");

    *memory.lock().unwrap() = Some(plenty());
    gate.pump();
    assert!(a.try_take().is_some(), "memory came back: re-checked on the next pump");
}

#[test]
fn a_probe_that_fails_counts_as_room() {
    let (gate, memory) = gate(1);
    *memory.lock().unwrap() = None;
    let mut a = gate.enter("a");
    assert!(a.try_take().is_some());
}

#[test]
fn memory_checks_off_never_read_the_probe() {
    let memory = Arc::new(Mutex::new(None));
    let settings = Settings { min_free_percent: 0.0, max_swap_gb: 0.0, ..Settings::default() };
    let gate = Gate::new(settings, Box::new(Fake(memory)));
    assert!(gate.enter("a").try_take().is_some());
    assert!(!gate.probe_warned.load(Ordering::Relaxed));
}

#[test]
fn a_bot_waiting_on_another_gives_its_slot_up_so_there_is_no_deadlock() {
    let (gate, _) = gate(1);
    let mut asker = gate.enter("a");
    let _held = asker.try_take().unwrap();
    // `a` asks `b`, whose request needs a slot.
    let mut request = gate.enter("b");
    assert!(request.try_take().is_none(), "the only slot is a's");
    let parked = gate.park("a");
    assert_eq!(running(&gate), 0);
    gate.pump();
    let answering = request.try_take().expect("b answers while a is parked");
    assert_eq!(running(&gate), 1);

    // The answer is ready: a waits for a slot again before it hears it.
    let mut resumed = Box::pin(parked.resume());
    let waker = futures::task::noop_waker();
    let mut cx = std::task::Context::from_waker(&waker);
    assert!(resumed.as_mut().poll(&mut cx).is_pending());
    drop(answering);
    gate.pump();
    assert!(resumed.as_mut().poll(&mut cx).is_ready());
    assert_eq!(running(&gate), 1, "a counts again");
}

#[test]
fn a_parked_turn_that_ends_or_is_cancelled_does_not_leak_or_double_count() {
    let (gate, _) = gate(1);
    // The turn ends while parked.
    let mut a = gate.enter("a");
    let permit = a.try_take().unwrap();
    let parked = gate.park("a");
    drop(permit);
    drop(parked);
    assert_eq!(running(&gate), 0);

    // The resume is cancelled while it waits: the turn counts again, once.
    let mut a = gate.enter("a");
    let permit = a.try_take().unwrap();
    let parked = gate.park("a");
    let mut other = gate.enter("b");
    let _b = other.try_take().unwrap();
    let mut resumed = Box::pin(parked.resume());
    let waker = futures::task::noop_waker();
    assert!(resumed.as_mut().poll(&mut std::task::Context::from_waker(&waker)).is_pending());
    drop(resumed);
    assert_eq!(running(&gate), 2);
    drop(permit);
    assert_eq!(running(&gate), 1);

    // Nothing is parked for an actor without a turn.
    let parked = gate.park("nobody");
    assert!(parked.slot.is_none());
}

#[test]
fn parallel_asks_keep_the_slot_given_up_until_the_last_is_back() {
    let (gate, _) = gate(1);
    let mut a = gate.enter("a");
    let _held = a.try_take().unwrap();
    // `a` asks `b` and `c` side by side; both requests need the one slot.
    let to_b = gate.park("a");
    let to_c = gate.park("a");
    assert_eq!(running(&gate), 0, "parked once, not twice");
    let mut b = gate.enter("b");
    let mut c = gate.enter("c");
    let answering_b = b.try_take().expect("b runs");
    assert!(c.try_take().is_none());

    // b answers first: a must not take the slot back while c still works for it.
    let waker = futures::task::noop_waker();
    let mut cx = std::task::Context::from_waker(&waker);
    let mut resume_b = Box::pin(to_b.resume());
    assert!(resume_b.as_mut().poll(&mut cx).is_ready(), "not the last ask: nothing to wait for");
    drop(answering_b);
    gate.pump();
    let answering_c = c.try_take().expect("c can start: a's slot is still given up");
    assert_eq!(running(&gate), 1);

    let mut resume_c = Box::pin(to_c.resume());
    assert!(resume_c.as_mut().poll(&mut cx).is_pending());
    drop(answering_c);
    gate.pump();
    assert!(resume_c.as_mut().poll(&mut cx).is_ready());
    assert_eq!(running(&gate), 1, "a counts again, once");
}

#[test]
fn an_owner_turn_goes_ahead_of_an_invitee_who_waited_longer() {
    let (gate, _) = gate(1);
    let mut busy = gate.enter("owner-a");
    let held = busy.try_take().unwrap();
    let mut sam = gate.enter_as("sam-chat", true);
    let mut owner = gate.enter("owner-b");
    assert!(sam.try_take().is_none() && owner.try_take().is_none());

    drop(held);
    gate.pump();
    assert!(sam.try_take().is_none(), "the invitee waits while an owner turn takes the slot");
    let owner_permit = owner.try_take().expect("the owner's turn is next, though it joined later");
    drop(owner_permit);
    gate.pump();
    assert!(sam.try_take().is_some(), "the invitee runs once no owner turn is waiting");
}

#[test]
fn two_invitees_never_run_at_once() {
    let (gate, _) = gate(3);
    let mut sam = gate.enter_as("sam-chat", true);
    let mut kim = gate.enter_as("kim-chat", true);
    let sam_permit = sam.try_take().expect("one invitee runs");
    assert!(kim.try_take().is_none(), "the second waits though two slots are free");
    assert_eq!(gate.status()["blocked"], "slots");
    // The owner's turns still use the free slots.
    let mut owner = gate.enter("owner");
    let _owner_permit = owner.try_take().expect("owner turn is not held back by the invitees' cap");

    drop(sam_permit);
    gate.pump();
    let _kim_permit = kim.try_take().expect("the slot an invitee gave back goes to the next invitee");
    assert_eq!(gate.invitees.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn an_invitee_turn_coming_back_from_a_wait_keeps_the_cap() {
    let (gate, _) = gate(3);
    let mut sam = gate.enter_as("sam-chat", true);
    let _sam_permit = sam.try_take().unwrap();
    let parked = gate.park("sam-chat");
    assert_eq!(gate.invitees.load(Ordering::Acquire), 0, "a parked turn gives its invitee slot up too");
    let mut kim = gate.enter_as("kim-chat", true);
    let kim_permit = kim.try_take().expect("another invitee takes the freed slot");
    // Sam's turn comes back only when the cap has room again.
    let back = tokio::spawn(parked.resume());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!back.is_finished(), "two invitees must not run at once");
    assert_eq!(gate.invitees.load(Ordering::Acquire), 1);
    drop(kim_permit);
    gate.pump();
    tokio::time::timeout(Duration::from_secs(2), back).await.expect("resumes once kim is done").unwrap();
    assert_eq!(gate.invitees.load(Ordering::Acquire), 1);
}
