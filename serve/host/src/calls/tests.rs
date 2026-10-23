//! Calls from an agent to its person: ringing, answering, the missed line, busy, the rate limit and who hears it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::api::devices::Caller;
use crate::api::rig::Rig;
use crate::api::{dispatch, events_stream};
use crate::remote::members::{self, Listed};
use futures::StreamExt;

async fn rpc(r: &Rig, caller: &Caller, method: &str, b: Value) -> Result<Value> {
    dispatch(&r.hub, caller, method, b).await
}

/// `sam`, invited to `house`, with a phone and a chat of their own.
async fn sam(r: &Rig) -> (Caller, String) {
    let made =
        rpc(r, &Caller::Local, "createInvite", json!({"name": "Sam", "agents": {"house": "member"}})).await.unwrap();
    let listed = [Listed {
        membership_id: "mem_sam".into(),
        user_id: "user_sam".into(),
        invite_id: made["inviteId"].as_str().unwrap().into(),
    }];
    members::apply(&r.hub, Some(&r.bin), &listed, Some("user_owner")).await.unwrap();
    let phone = r.device("sam-phone", Some("sam"));
    let chat =
        rpc(r, &phone, "startChat", json!({"agent": "house"})).await.unwrap()["bot"]["id"].as_str().unwrap().to_owned();
    (phone, chat)
}

async fn calls_seen(r: &Rig, caller: &Caller) -> Vec<Value> {
    let stream = events_stream(&r.hub, 0, None, caller).unwrap();
    Box::pin(stream)
        .take_until(tokio::time::sleep(Duration::from_millis(300)))
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter(|e| e["type"] == "call")
        .collect()
}

fn ring_for(r: &Rig, bot: &str, reason: &str) -> Value {
    ring(&r.hub, bot, None, reason).unwrap()
}

fn notices(r: &Rig, bot: &str) -> Vec<Value> {
    r.hub.store.history(bot, i64::MAX, 50).unwrap().into_iter().filter(|e| e.kind == "notice").map(|e| e.data).collect()
}

#[tokio::test]
async fn a_call_rings_once_and_the_first_answer_wins() {
    let r = Rig::new().await;
    let bot = r.owner_bot("house");
    let out = ring_for(&r, &bot, "  the\nbill is   due ");
    assert_eq!(out["status"], "ringing");
    let id = out["id"].as_str().unwrap().to_owned();

    let seen = calls_seen(&r, &Caller::Local).await;
    assert_eq!(seen.len(), 1, "an app that connects while it rings gets the call");
    assert_eq!(seen[0]["call"]["reason"], "the bill is due");
    assert_eq!(seen[0]["call"]["botId"], bot.as_str());
    assert_eq!(seen[0]["call"]["state"], "ringing");

    let owner = r.device("owner-phone", None);
    let accepted = rpc(&r, &owner, "callAccept", json!({"id": id})).await.unwrap();
    assert_eq!(accepted["botId"], bot.as_str());
    let late = rpc(&r, &Caller::Local, "callAccept", json!({"id": id})).await.unwrap_err();
    assert!(late.to_string().contains("already accepted"), "{late:#}");
    let late = rpc(&r, &Caller::Local, "callDecline", json!({"id": id})).await.unwrap_err();
    assert!(late.to_string().contains("already accepted"), "{late:#}");
    assert!(calls_seen(&r, &Caller::Local).await.is_empty(), "nothing rings any more");
    assert!(notices(&r, &bot).is_empty(), "an accepted call leaves its line once the call is live");

    // The agent speaks first, once, on a line that isn't the person's words.
    rpc(&r, &owner, "callGreet", json!({"id": id})).await.unwrap();
    assert!(rpc(&r, &owner, "callGreet", json!({"id": id})).await.is_err());
    assert_eq!(notices(&r, &bot)[0]["text"], "house called: the bill is due");
    // Its end frees the person for the next call.
    assert_eq!(ring_for(&r, &r.owner_bot("money"), "x")["status"], "busy");
    r.hub.calls.ended(&bot);
    assert_eq!(ring_for(&r, &r.owner_bot("money"), "x")["status"], "ringing");
}

#[tokio::test]
async fn declining_and_ringing_out_leave_a_line_in_the_chat() {
    let r = Rig::new().await;
    let bot = r.owner_bot("house");
    let id = ring_for(&r, &bot, "lunch?")["id"].as_str().unwrap().to_owned();
    rpc(&r, &Caller::Local, "callDecline", json!({"id": id})).await.unwrap();
    let lines = notices(&r, &bot);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["text"], "house tried to call: lunch?");
    assert_eq!(lines[0]["missedCall"], true);
    assert_eq!(lines[0]["callState"], "declined");
    assert!(rpc(&r, &Caller::Local, "callDecline", json!({"id": id})).await.is_err(), "decline after the fact");

    // Nobody answers: it rings out. A different agent, so the rate limit isn't what is tested.
    r.hub.calls.set_ring_ms(40);
    let money = r.owner_bot("money");
    let out = ring_and_wait(&r.hub, &money, None, "late", true).await.unwrap();
    assert_eq!(out["status"], "missed");
    assert_eq!(notices(&r, &money)[0]["text"], "money tried to call: late");
    assert_eq!(notices(&r, &money)[0]["callState"], "missed");
    assert!(rpc(&r, &Caller::Local, "callAccept", json!({"id": out["id"]})).await.is_err(), "accept after the timeout");
}

#[tokio::test]
async fn a_person_is_on_one_call_and_an_agent_rings_rarely() {
    let r = Rig::new().await;
    let (house, money) = (r.owner_bot("house"), r.owner_bot("money"));
    let id = ring_for(&r, &house, "one")["id"].as_str().unwrap().to_owned();
    assert_eq!(ring_for(&r, &money, "two")["status"], "busy", "another agent while one rings");
    assert_eq!(ring_for(&r, &house, "again")["status"], "busy", "the same agent twice quickly");
    decline_now(&r, &id);

    // Declined, so nobody is busy, but `house` rang a minute ago.
    let out = ring_for(&r, &house, "pester");
    assert_eq!(out["status"], "rate-limited");
    assert!(out["retryAfterSeconds"].as_i64().unwrap() > 500);
    let calm = ring_for(&r, &money, "different agent");
    assert_eq!(calm["status"], "ringing");
    decline_now(&r, calm["id"].as_str().unwrap());

    // Ten minutes on it may ring again; the sixth in a day is the last.
    let now = now_ms();
    let hours = |h: i64| now - h * 60 * 60 * 1000;
    r.hub.calls.inner.locked().rung.insert("house".into(), (1..=5).rev().map(hours).collect());
    let sixth = ring_for(&r, &house, "sixth");
    assert_eq!(sixth["status"], "ringing");
    decline_now(&r, sixth["id"].as_str().unwrap());
    r.hub.calls.inner.locked().rung.get_mut("house").unwrap().iter_mut().for_each(|t| *t -= 11 * 60 * 1000);
    assert_eq!(ring_for(&r, &house, "seventh")["status"], "rate-limited", "six in the last day");
    assert_eq!(ring(&r.hub, "unknown", None, "x").unwrap(), json!({"status": "not-allowed"}));
}

fn decline_now(r: &Rig, id: &str) {
    settle(&r.hub, id, State::Declined, None).unwrap();
}

#[tokio::test]
async fn the_ring_history_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("kith-calls-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("calls.json");
    let first = Calls::open(Some(path.clone()), RING_MS);
    let rung = HashMap::from([("house".to_owned(), vec![now_ms() - 1000])]);
    first.save(&rung);
    let again = Calls::open(Some(path), RING_MS);
    assert_eq!(again.inner.locked().rung["house"].len(), 1);
    assert!(Calls::open(None, RING_MS).inner.locked().rung.is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_call_reaches_only_the_person_whose_chat_it_is() {
    let r = Rig::new().await;
    let mine = r.owner_bot("house");
    let (phone, theirs) = sam(&r).await;

    // The owner's call: the owner hears it, Sam does not and cannot answer it.
    let owners = ring_for(&r, &mine, "owner only");
    let id = owners["id"].as_str().unwrap().to_owned();
    assert_eq!(calls_seen(&r, &Caller::Local).await.len(), 1);
    assert!(calls_seen(&r, &phone).await.is_empty());
    for method in ["callAccept", "callDecline", "callGreet"] {
        let e = rpc(&r, &phone, method, json!({"id": id})).await.unwrap_err();
        assert!(e.to_string().contains("gone"), "{method}: {e:#}");
    }
    decline_now(&r, &id);

    r.hub.calls.inner.locked().rung.clear();
    // Sam's call: only Sam's devices; the owner's stream and answers are shut out. Sam being called is not busy for the owner.
    let sams = ring_for(&r, &theirs, "sam only");
    assert_eq!(sams["status"], "ringing");
    let sid = sams["id"].as_str().unwrap().to_owned();
    assert_eq!(calls_seen(&r, &phone).await.len(), 1);
    assert!(calls_seen(&r, &Caller::Local).await.is_empty(), "the owner never hears an invitee's call");
    let e = rpc(&r, &Caller::Local, "callAccept", json!({"id": sid})).await.unwrap_err();
    assert!(e.to_string().contains("gone"), "{e:#}");
    rpc(&r, &phone, "callAccept", json!({"id": sid})).await.unwrap();

    // The loopback call is the agent's alone: no device, member or not, may place one.
    assert!(rpc(&r, &phone, "callPerson", json!({"agent": "house", "reason": "x"})).await.is_err());
    let owner = r.device("owner-phone", None);
    assert!(rpc(&r, &owner, "callPerson", json!({"agent": "house", "reason": "x"})).await.is_err());
}

#[tokio::test]
async fn the_cli_rings_the_chat_of_the_person_it_runs_for() {
    let r = Rig::new().await;
    let mine = r.owner_bot("house");
    let (_, theirs) = sam(&r).await;
    assert_eq!(chat_of(&r.hub, "house", None).as_deref(), Some(mine.as_str()));
    assert_eq!(chat_of(&r.hub, "house", Some("sam")).as_deref(), Some(theirs.as_str()));
    assert_eq!(chat_of(&r.hub, "money", None), None);
    assert_eq!(chat_of(&r.hub, "house", Some("kim")), None);

    let out = rpc(&r, &Caller::Local, "callPerson", json!({"agent": "house", "person": "sam", "reason": "hi"}))
        .await
        .unwrap();
    assert_eq!(out["status"], "ringing");
    let none = rpc(&r, &Caller::Local, "callPerson", json!({"agent": "money", "reason": "hi"})).await.unwrap();
    assert_eq!(none["status"], "not-allowed", "an agent with no chat of that person's rings nobody");
    assert!(rpc(&r, &Caller::Local, "callPerson", json!({"agent": "house", "reason": "  "})).await.is_err());
}
