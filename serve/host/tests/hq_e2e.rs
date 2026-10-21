//! hq agents as bots, against a stub `hq` and a scripted ACP agent: the bot appears from `hq ls --json`, its first
//! message starts the agent from `hq <agent> --launch-json`, and the session carries hq's prompt and servers and
//! none of Kith's.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::host::Host;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

struct Setup {
    host: Host,
    /// The agent's folder.
    home: PathBuf,
}

async fn start() -> Setup {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let home = std::env::temp_dir().join(format!("kith-hq-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    let stub = fixtures.join("stub_hq.py");
    let acp = format!("{} claude", common::python_agent(&fixtures.join("instructions_agent.py")));
    let home_text = home.to_string_lossy().into_owned();
    let host = Host::start_env(&[
        ("HQ_BIN", &stub.to_string_lossy()),
        ("STUB_HQ_HOME", &home_text),
        ("KITH_SERVE_HQ_ACP_COMMAND", &acp),
    ])
    .await;
    Setup { host, home }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

impl Setup {
    /// The roster's `house` bot, once the startup sync made it.
    async fn house(&self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(bot) = self.host.roster().await.into_iter().find(|b| b["hqAgent"] == "house") {
                return bot;
            }
            assert!(Instant::now() < deadline, "house never appeared");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn lines(&self, file: &str) -> Vec<Value> {
        let text = std::fs::read_to_string(self.home.join(file)).unwrap_or_default();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        self.lines("requests.jsonl").into_iter().filter(|r| r["method"] == method).collect()
    }

    fn launches(&self) -> Vec<Value> {
        self.lines("calls.jsonl").into_iter().filter(|c| c["args"][1] == "--launch-json").collect()
    }
}

fn same_dir(a: &str, b: &Path) -> bool {
    std::fs::canonicalize(a).unwrap() == std::fs::canonicalize(b).unwrap()
}

#[tokio::test]
async fn an_hq_agent_appears_and_starts_from_launch_json() {
    let s = start().await;
    let bot = s.house().await;
    assert_eq!(bot["description"], "Keeps the house");
    assert_eq!(bot["backend"], "claude");
    assert_eq!(bot["permission"], "ask");
    assert!(s.launches().is_empty(), "nothing starts before the first message");
    let id = bot["id"].as_str().unwrap();

    s.host.reply(id, "what do you keep track of?").await;

    let launches = s.launches();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0]["via"], "serve");
    assert!(same_dir(launches[0]["cwd"].as_str().unwrap(), &s.home), "run in the bot's folder");

    let new = s.requests("session/new");
    assert_eq!(new.len(), 1);
    let params = &new[0]["params"];
    assert!(same_dir(params["cwd"].as_str().unwrap(), &s.home));
    assert_eq!(params["mcpServers"], json!([]), "no chat, memory, team, routines or connectors servers");
    assert_eq!(params["_meta"]["systemPrompt"], json!({"append": "You are house, the household keeper."}));
    let options = &params["_meta"]["claudeCode"]["options"];
    assert_eq!(options["strictMcpConfig"], true);
    assert_eq!(options["mcpServers"]["pantry"]["command"], "pantry-mcp");
    assert_eq!(options["allowedTools"], json!(["Read"]));
    assert_eq!(options["extraArgs"], json!({"disable-slash-commands": null}));
    assert_eq!(options["model"], "haiku");
    assert!(options["settings"]["hooks"].is_object());
    assert!(!params.to_string().contains("Kith"), "nothing of the host's own instructions: {params}");

    let prompts = s.requests("session/prompt");
    assert_eq!(prompts[0]["params"]["prompt"][0]["text"], "what do you keep track of?", "no bot profile around it");

    // A second message uses the live session: hq is not asked again.
    s.host.reply(id, "and the shopping list?").await;
    assert_eq!(s.launches().len(), 1);
    assert_eq!(s.requests("session/new").len(), 1);
}

#[tokio::test]
async fn the_host_restart_loads_the_session_with_a_fresh_launch() {
    let mut s = start().await;
    let id = s.house().await["id"].as_str().unwrap().to_owned();
    s.host.reply(&id, "hello").await;
    s.host.restart(|_| {}).await;
    s.house().await;
    s.host.reply(&id, "again").await;
    assert_eq!(s.launches().len(), 2, "the launch is fetched again");
    let load = s.requests("session/load");
    assert_eq!(load.len(), 1);
    assert_eq!(load[0]["params"]["sessionId"], "s1");
    assert_eq!(load[0]["params"]["_meta"]["systemPrompt"]["append"], "You are house, the household keeper.");
    assert_eq!(s.requests("session/new").len(), 1);
}

#[tokio::test]
async fn a_failing_launch_says_why_in_the_chat() {
    let s = start().await;
    let id = s.house().await["id"].as_str().unwrap().to_owned();
    std::fs::write(s.home.join("fail"), "house is not allowed here").unwrap();
    s.host.call("send", json!({"botId": id, "text": "hi", "clientNonce": "n1"})).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let history = s.host.call("history", json!({"botId": id})).await;
        let notice = history["entries"].as_array().unwrap().iter().find(|e| {
            e["kind"] == "notice" && e["data"]["text"].as_str().is_some_and(|t| t.contains("house is not allowed here"))
        });
        if notice.is_some() {
            break;
        }
        assert!(Instant::now() < deadline, "no readable error: {history}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(s.requests("session/new").is_empty(), "no fallback to a plain claude");
}

#[tokio::test]
async fn syncing_again_makes_no_second_bot() {
    let s = start().await;
    s.house().await;
    let done = s.host.call("syncHqBots", json!({})).await;
    assert_eq!(done["created"], json!([]));
    let houses = s.host.roster().await.into_iter().filter(|b| b["hqAgent"] == "house").count();
    assert_eq!(houses, 1);
}
