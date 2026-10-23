//! A permission prompt raised in an invited person's chat, through the real actor path (a scripted ACP agent asks for
//! one): the card offers only allow/reject once, says whose run it is, goes to the owner, and gives the gate slot back
//! while it waits.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::host::Host;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;

async fn gate(host: &Host) -> Value {
    let health: Value = reqwest::get(format!("{}/health", host.base())).await.unwrap().json().await.unwrap();
    health["gate"].clone()
}

/// Polls the chat's entries (the host's database: a task's cards live in a thread of the chat) until `pred` matches
/// one, newest first.
async fn wait_for(host: &Host, bot: &str, pred: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..200 {
        let db = rusqlite::Connection::open(host.home.join("serve.db")).unwrap();
        let mut st = db.prepare("SELECT id, kind, data FROM entries WHERE bot_id = ?1 ORDER BY seq DESC").unwrap();
        let rows: Vec<Value> = st
            .query_map([bot], |r| {
                let data: String = r.get(2)?;
                Ok(json!({"id": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?,
                    "data": serde_json::from_str::<Value>(&data).unwrap()}))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        if let Some(e) = rows.into_iter().find(|e| pred(e)) {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting in {bot}");
}

#[tokio::test]
async fn an_invitees_prompt_offers_only_once_choices_and_waits_for_the_owner_without_a_slot() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let home = std::env::temp_dir().join(format!("kith-invitee-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    let acp = format!(
        "{} claude",
        common::python_agent(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prompt_agent.py"))
    );
    let mut host = Host::start_env(&[
        ("KITH_KERNEL_BIN", &fixtures.join("stub_hq.py").to_string_lossy()),
        ("STUB_HQ_HOME", &home.to_string_lossy()),
        ("KITH_SERVE_HQ_ACP_COMMAND", &acp),
        // Never this Mac's kith-auth: the host asks it who may approve, and an empty one answers "nobody".
        ("KITH_AUTH", &home.join("auth.json").to_string_lossy()),
        ("KITH_STATE", &home.join("state").to_string_lossy()),
        ("KITH_HOME", &home.join("kith-home").to_string_lossy()),
    ])
    .await;

    // The roster's `house` bot becomes sam's chat: only the host makes such a chat (an invitee's device calls
    // `startChat`), so the test edits its database while the host is stopped.
    for _ in 0..200 {
        if host.roster().await.iter().any(|b| b["hqAgent"] == "house") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut chat = String::new();
    host.restart(|dir| {
        let db = rusqlite::Connection::open(dir.join("serve.db")).unwrap();
        let n = db.execute("UPDATE bots SET config = json_set(config, '$.person', 'sam')", []).unwrap();
        assert_eq!(n, 1, "one bot, the house");
        chat = db.query_row("SELECT id FROM bots", [], |r| r.get(0)).unwrap();
    })
    .await;
    host.call("send", json!({"botId": chat, "text": "go", "clientNonce": "n1"})).await;

    let card = wait_for(&host, &chat, |e| e["kind"] == "permission" && e["data"]["status"] == "pending").await;
    let ids: Vec<&str> =
        card["data"]["options"].as_array().unwrap().iter().map(|o| o["optionId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["allow", "no"], "no 'always' choice in an invitee's chat: {card}");
    assert_eq!(
        (&card["data"]["person"], &card["data"]["agent"], &card["data"]["approver"]),
        (&json!("sam"), &json!("house"), &json!("owner")),
        "kith-auth can't be asked here, so the owner answers"
    );
    assert!(card["data"]["cwd"].is_null(), "the agent's folder isn't shown");

    // The slot is back with the gate while the owner decides.
    assert_eq!(gate(&host).await["running"], 0);

    // A choice the card never offered is refused, whoever asks.
    let why = host.refused("respondPermission", json!({"entryId": card["id"], "optionId": "always"})).await;
    assert!(why.contains("choices"), "{why}");
    host.call("respondPermission", json!({"entryId": card["id"], "optionId": "allow"})).await;
    let reply = wait_for(&host, &chat, |e| e["kind"] == "agent" && e["data"]["final"] == true).await;
    assert!(reply["data"]["text"].as_str().unwrap().contains("\"allow\""), "{reply}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(gate(&host).await["running"], 0, "the turn is over and the slot is free");
    let _ = std::fs::remove_dir_all(&home);
}
