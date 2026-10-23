//! The invite proof, the run gate, answer shaping and what the host takes back, against a real kith-auth in a temp folder.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::devices::{Caller, NotAllowed};
use super::rig::Rig;
use super::{dispatch, events_stream, roles};
use crate::remote::members::{self, Listed};
use serde_json::{Value, json};

async fn call(r: &Rig, caller: &Caller, method: &str, b: Value) -> anyhow::Result<Value> {
    dispatch(&r.hub, caller, method, b).await
}

fn denied(e: &anyhow::Error) -> bool {
    e.is::<NotAllowed>() || e.is::<super::devices::Forbidden>()
}

async fn joined(r: &Rig, roles: Value) -> Caller {
    let made = call(r, &Caller::Local, "createInvite", json!({"name": "Sam", "agents": roles})).await.unwrap();
    let listed = [Listed {
        membership_id: "mem_sam".into(),
        user_id: "user_sam".into(),
        invite_id: made["inviteId"].as_str().unwrap().to_owned(),
    }];
    members::apply(&r.hub, Some(&r.bin), &listed, Some("user_owner")).await.unwrap();
    r.device("sam-phone", Some("sam"))
}

#[tokio::test]
async fn an_unproven_device_can_only_prove_and_only_a_few_times() {
    let r = Rig::new().await;
    let made =
        call(&r, &Caller::Local, "createInvite", json!({"name": "Sam", "agents": {"house": "member"}})).await.unwrap();
    let invite = made["inviteId"].as_str().unwrap().to_owned();
    let t = made["link"].as_str().unwrap().rsplit("t=").next().unwrap().to_owned();
    let listed = [Listed { membership_id: "mem_sam".into(), user_id: "user_sam".into(), invite_id: invite.clone() }];
    members::apply(&r.hub, Some(&r.bin), &listed, Some("user_owner")).await.unwrap();
    let phone = r.unproven_device("new-phone", Some("sam"));
    for m in ["hello", "history", "startChat", "linkCode", "people", "settings"] {
        let e = call(&r, &phone, m, json!({})).await.expect_err(m);
        assert!(denied(&e), "{m}: {e:#}");
    }
    assert!(events_stream(&r.hub, 0, None, &phone).is_err(), "no event stream either");
    for _ in 0..5 {
        let e = call(&r, &phone, "proveInvite", json!({"inviteId": invite, "token": "wrong"})).await.unwrap_err();
        assert!(e.is::<NotAllowed>());
    }
    let e = call(&r, &phone, "proveInvite", json!({"inviteId": invite, "token": t})).await.unwrap_err();
    assert!(format!("{e:#}").contains("Too many"), "the right token is refused once the tries are used: {e:#}");
    let rows = r.hub.store.audit_list(0, Some("sam")).unwrap();
    assert!(rows.iter().filter(|a| a.method == "proveInvite" && !a.allowed).count() >= 5);
    // Another device has its own tries, and an invite id that isn't theirs fails.
    let other = r.unproven_device("other-phone", Some("sam"));
    assert!(call(&r, &other, "proveInvite", json!({"inviteId": "inv_nope", "token": t})).await.is_err());
    call(&r, &other, "proveInvite", json!({"inviteId": invite, "token": t})).await.unwrap();
    assert!(call(&r, &other, "proveInvite", json!({"inviteId": invite, "token": t})).await.is_err(), "once is enough");
}

#[tokio::test]
async fn members_cannot_run_agents_yet() {
    let r = Rig::new().await;
    r.owner_bot("house");
    let sam = joined(&r, json!({"house": "member"})).await;
    let chat =
        call(&r, &sam, "startChat", json!({"agent": "house"})).await.unwrap()["bot"]["id"].as_str().unwrap().to_owned();
    let entry = r
        .hub
        .add_entry(&crate::store::Lane::main(&chat), crate::store::EntryKind::Agent, 1, &json!({"text": "ok?"}))
        .unwrap();
    for (m, b) in [
        ("send", json!({"botId": chat, "text": "hi"})),
        ("newSession", json!({"botId": chat})),
        ("respondPermission", json!({"entryId": entry.id})),
        ("editHandoff", json!({"entryId": entry.id, "text": "x"})),
        ("keepConversation", json!({"entryId": entry.id})),
    ] {
        let e = call(&r, &sam, m, b).await.expect_err(m);
        assert!(e.is::<NotAllowed>(), "{m}: {e:#}");
    }
    call(&r, &sam, "history", json!({"botId": chat})).await.unwrap();
    call(&r, &sam, "stop", json!({"botId": chat})).await.unwrap();
}

#[tokio::test]
async fn answers_leave_out_this_computers_folders() {
    let r = Rig::new().await;
    let shaped = roles::shape(&r.hub, "sam", "history", json!({"entries": [], "folder": {"path": "/Users/x"}}));
    assert_eq!(shaped, json!({"entries": []}));
    let info = json!({"info": {"name": "house", "description": "d", "avatar": "a", "memory": {"dir": "/Users/x"}},
        "fetchedAt": 5, "error": "/Users/x"});
    assert_eq!(
        roles::shape(&r.hub, "sam", "kithInfo", info),
        json!({"info": {"name": "house", "description": "d", "avatar": "a"}, "fetchedAt": 5})
    );
}

#[tokio::test]
async fn person_ids_are_checked_and_only_our_own_grants_are_taken_back() {
    let r = Rig::new().await;
    for bad in ["-x", "Sam", "a b", "1x"] {
        let e = call(&r, &Caller::Local, "createInvite", json!({"personId": bad, "agents": {"house": "guest"}}))
            .await
            .unwrap_err();
        assert!(format!("{e:#}").contains("isn't a person id"), "{bad}: {e:#}");
    }
    // A person the owner already had, with a membership the owner gave by hand.
    r.auth(&["person", "kim"]);
    r.auth(&["member", "money", "kim", "preset=member"]);
    let both = json!({"personId": "kim", "agents": {"house": "guest", "money": "guest"}});
    call(&r, &Caller::Local, "createInvite", both).await.unwrap();
    assert_eq!(r.hub.store.person("kim").unwrap().made, ["house"], "money was already theirs");
    let only = |a: Value| json!({"personId": "kim", "agents": a});
    call(&r, &Caller::Local, "setPersonAccess", only(json!({"money": "guest"}))).await.unwrap();
    assert!(!r.allowed("kim", "house"), "the one this host made goes");
    call(&r, &Caller::Local, "setPersonAccess", only(json!({}))).await.unwrap();
    assert!(r.allowed("kim", "money"), "the owner's own membership is left in place");
    call(&r, &Caller::Local, "revokePerson", json!({"personId": "kim"})).await.unwrap();
    assert!(r.allowed("kim", "money"));
}

#[tokio::test]
async fn a_deleted_template_makes_no_chat_and_a_second_account_keeps_the_handle() {
    let r = Rig::new().await;
    let owner_bot = r.owner_bot("house");
    let sam = joined(&r, json!({"house": "member"})).await;
    r.hub.delete_bot(&owner_bot).unwrap();
    let e = call(&r, &sam, "startChat", json!({"agent": "house"})).await.unwrap_err();
    assert!(format!("{e:#}").contains("isn't set up"), "{e:#}");

    // Two accounts on one person: losing one leaves the other bound.
    let made = call(&r, &Caller::Local, "createInvite", json!({"personId": "sam", "agents": {"house": "member"}}))
        .await
        .unwrap();
    let second = Listed {
        membership_id: "mem_two".into(),
        user_id: "user_two".into(),
        invite_id: made["inviteId"].as_str().unwrap().to_owned(),
    };
    let first = Listed { membership_id: "mem_sam".into(), user_id: "user_sam".into(), invite_id: "inv_x".into() };
    let bin = Some(r.bin.as_path());
    members::apply(&r.hub, bin, &[first, second.clone()], Some("user_owner")).await.unwrap();
    assert_eq!(r.who("user_two")["person"], "sam");
    members::apply(&r.hub, bin, &[second], Some("user_owner")).await.unwrap();
    assert_eq!(r.who("user_two")["person"], "sam", "the remaining account stays bound");
    assert!(r.hub.store.device("sam-phone").is_some(), "the person's devices stay while one account remains");
}
