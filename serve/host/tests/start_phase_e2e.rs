//! A real host whose agent is slow to start a session: Stop still works meanwhile, and a `send_message` the host
//! told the agent had failed never shows up afterwards.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(dead_code)]
mod common;

use common::host::Host;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn python_missing() -> bool {
    let missing = std::process::Command::new(common::python()).arg("--version").output().is_err();
    if missing {
        eprintln!("skipping: Python not available");
    }
    missing
}

async fn history(host: &Host, bot: &str) -> Vec<Value> {
    host.call("history", json!({"botId": bot})).await["entries"].as_array().unwrap().clone()
}

async fn wait_until(what: &str, timeout: Duration, mut done: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn status(host: &Host, bot: &str) -> String {
    let roster = host.roster().await;
    roster.iter().find(|b| b["id"] == bot).map(|b| b["status"].as_str().unwrap_or_default().to_owned()).unwrap()
}

#[tokio::test]
async fn stop_ends_a_turn_that_is_still_starting_and_the_next_message_starts_afresh() {
    if python_missing() {
        return;
    }
    let host = Host::start().await;
    // session/new takes 60 s the first time: the turn is stuck starting.
    let bot = host.fixture_bot("Stalled", "stall_agent.py", "60 0").await;
    host.call("send", json!({"botId": bot, "text": "first", "clientNonce": "n1"})).await;
    wait_until("the turn to start", Duration::from_secs(10), async || status(&host, &bot).await == "working").await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    host.call("stop", json!({"botId": bot})).await;
    wait_until("the stop to end the start", Duration::from_secs(10), async || status(&host, &bot).await == "idle")
        .await;
    assert!(history(&host, &bot).await.iter().any(|e| e["kind"] == "notice" && e["data"]["text"] == "Stopped."));

    // A fresh agent process answers at once.
    host.reply(&bot, "second").await;
    let echoed = history(&host, &bot).await.iter().any(|e| e["data"]["text"].as_str().is_some_and(|t| t.contains("second")));
    assert!(echoed);
}

#[tokio::test]
async fn a_message_the_host_reported_as_failed_is_not_posted_later() {
    if python_missing() {
        return;
    }
    let host = Host::start().await;
    // The session takes 13 s: longer than the 10 s the host waits for a `send_message` to be taken. The turn then
    // runs 4 s more, so the late message would still find a turn to post into.
    let bot = host.fixture_bot("Slow start", "stall_agent.py", "13 4").await;
    host.call("send", json!({"botId": bot, "text": "go", "clientNonce": "n1"})).await;
    wait_until("the turn to start", Duration::from_secs(10), async || status(&host, &bot).await == "working").await;
    let (ok, body) = host
        .post("chatCall", &json!({"botId": bot, "name": "send_message", "arguments": {"text": "late bubble"}}))
        .await;
    assert!(!ok, "the host should have reported the timeout: {body}");

    wait_until("the turn to finish", Duration::from_secs(30), async || {
        history(&host, &bot).await.iter().any(|e| e["data"]["text"].as_str().is_some_and(|t| t.starts_with("Echo: ")))
    })
    .await;
    wait_until("the bot to be idle", Duration::from_secs(10), async || status(&host, &bot).await == "idle").await;
    assert!(
        !history(&host, &bot).await.iter().any(|e| e["data"]["text"] == "late bubble"),
        "the message the agent was told had failed was posted"
    );
}
