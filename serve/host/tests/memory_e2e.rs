//! Bot memory on a real host with disposable data: moving the old memory, the user's edits, a bot's writes by
//! its permission, and dreaming.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(dead_code)]
mod common;

use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::Child,
    time::{Duration, Instant},
};

struct Host {
    child: Child,
    home: PathBuf,
    base: String,
    token: String,
}

impl Drop for Host {
    fn drop(&mut self) {
        common::stop(&mut self.child);
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

impl Host {
    async fn start() -> Self {
        let home = std::env::temp_dir().join(format!("codync-memory-e2e-{}", uuid::Uuid::new_v4()));
        let (child, base) = common::serve(&home).await;
        let token = std::fs::read_to_string(home.join("token")).unwrap().trim().to_owned();
        Self { child, home, base, token }
    }

    /// Stops the host, lets `between` change its files, and starts it again on the same data.
    async fn restart(&mut self, between: impl FnOnce(&std::path::Path)) {
        common::stop(&mut self.child);
        between(&self.home);
        let (child, base) = common::serve(&self.home).await;
        self.child = child;
        self.base = base;
    }

    async fn post(&self, method: &str, body: &Value) -> (bool, Value) {
        let response = reqwest::Client::new()
            .post(format!("{}/api/{method}", self.base))
            .bearer_auth(&self.token)
            .json(body)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .unwrap();
        let ok = response.status().is_success();
        (ok, response.json().await.unwrap())
    }

    async fn call(&self, method: &str, body: Value) -> Value {
        let (ok, body) = self.post(method, &body).await;
        assert!(ok, "{method}: {body}");
        body
    }

    /// A call that must be refused: its error text.
    async fn refused(&self, method: &str, body: Value) -> String {
        let (ok, body) = self.post(method, &body).await;
        assert!(!ok, "{method} should have been refused: {body}");
        body["error"].as_str().unwrap_or_default().to_owned()
    }

    async fn bot(&self, name: &str, permission: &str) -> String {
        let bot =
            json!({"name": name, "backend": "custom", "command": "unused", "connectors": [], "permission": permission});
        self.call("createBot", bot).await["bot"]["id"].as_str().unwrap().to_owned()
    }

    async fn memory(&self, bot: &str) -> Value {
        self.call("memory", json!({"botId": bot})).await
    }

    async fn tool(&self, bot: &str, name: &str, arguments: Value) -> Value {
        self.call("memoryCall", json!({"botId": bot, "name": name, "arguments": arguments})).await
    }

    async fn tool_refused(&self, bot: &str, name: &str, arguments: Value) -> String {
        self.refused("memoryCall", json!({"botId": bot, "name": name, "arguments": arguments})).await
    }

    /// The newest memory line in a bot's chat.
    async fn card(&self, bot: &str) -> Value {
        let history = self.call("history", json!({"botId": bot})).await;
        history["entries"].as_array().unwrap().iter().rev().find(|e| e["data"]["memory"].is_object()).unwrap().clone()
    }
}

fn texts(layer: &Value, state: &str) -> Vec<String> {
    layer["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["state"] == state)
        .map(|e| e["text"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn moves_old_memory_once_and_keeps_the_layers_apart() {
    let mut host = Host::start().await;
    let a = host.bot("Memory A", "auto").await;
    let b = host.bot("Memory B", "auto").await;
    let (legacy, engram) =
        (host.home.join("bots").join(&a).join("memory"), host.home.join("bots").join(&b).join("engram"));
    host.restart(|_| {
        // Markdown from before Engram for A; an Engram database for B.
        std::fs::create_dir_all(legacy.join("log")).unwrap();
        std::fs::write(legacy.join("profile.md"), "- (2026-01-01) 偏好繁體中文\n- (2026-01-02) Lives in Taipei\n")
            .unwrap();
        std::fs::write(legacy.join("log/2026-02.md"), "- (2026-02-02) Shipped Codync\n").unwrap();
        std::fs::create_dir_all(&engram).unwrap();
        let db = rusqlite::Connection::open(engram.join("engram.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE observations (id INTEGER PRIMARY KEY, content TEXT, scope TEXT, pinned INTEGER,
                created_at TEXT, type TEXT, deleted_at TEXT);
             INSERT INTO observations (content, scope, pinned, created_at, type, deleted_at) VALUES
                ('Has a daughter named Mei', 'personal', 1, '2026-03-01 10:00:00', 'learning', NULL),
                ('[note] Uses vim keybindings', 'project', 0, '2026-03-02 10:00:00', 'discovery', NULL),
                ('A forgotten fact', 'personal', 0, '2026-03-03 10:00:00', 'learning', '2026-03-04 10:00:00'),
                ('What one session did', 'project', 0, '2026-03-05 10:00:00', 'session_summary', NULL);",
        )
        .unwrap();
    })
    .await;

    let view = host.memory(&a).await;
    assert_eq!(texts(&view["bot"], "active"), ["Shipped Codync", "Lives in Taipei", "偏好繁體中文"]);
    assert_eq!(view["bot"]["entries"][0]["author"], "imported");
    assert!(!legacy.exists(), "the old files go once moved");
    let view = host.memory(&b).await;
    assert_eq!(texts(&view["bot"], "active"), ["Has a daughter named Mei", "Uses vim keybindings"]);
    assert_eq!(view["bot"]["entries"][0]["pinned"], true);
    assert!(!engram.exists());
    host.restart(|_| {}).await;
    assert_eq!(host.memory(&a).await["bot"]["entries"].as_array().unwrap().len(), 3, "nothing moves twice");

    // A shared fact reaches every bot that uses the shared layer; a bot's own stays with it.
    host.call("saveMemory", json!({"botId": a, "shared": true, "text": "Time zone is Asia/Taipei"})).await;
    let own = host.call("saveMemory", json!({"botId": b, "text": "Reviews PRs on Fridays"})).await;
    let own = own["entry"]["id"].as_i64().unwrap();
    let view = host.memory(&a).await;
    assert_eq!(view["shared"], true, "a bot in its own workspace uses the shared layer");
    assert_eq!(texts(&view["yours"], "active"), ["Time zone is Asia/Taipei"]);
    assert!(!view.to_string().contains("Reviews PRs"));
    assert!(host.refused("forgetMemory", json!({"botId": a, "id": own})).await.contains("No such memory"));

    host.call("pinMemory", json!({"botId": b, "id": own, "pinned": true})).await;
    host.call("archiveMemory", json!({"botId": b, "id": own, "archived": true})).await;
    assert_eq!(texts(&host.memory(&b).await["bot"], "archived"), ["Reviews PRs on Fridays"]);
    host.call("archiveMemory", json!({"botId": b, "id": own, "archived": false})).await;
    assert_eq!(texts(&host.memory(&b).await["bot"], "active")[0], "Reviews PRs on Fridays", "pinned first");
    host.call("forgetMemory", json!({"botId": b, "id": own})).await;
    host.call("clearMemory", json!({"botId": a, "shared": true})).await;
    let view = host.memory(&b).await;
    assert_eq!(view["yours"]["entries"], json!([]));
    assert!(!view.to_string().contains("Reviews PRs"));
}

#[tokio::test]
async fn bots_write_memory_by_their_permission() {
    let host = Host::start().await;
    let auto = host.bot("Auto", "auto").await;
    let ask = host.bot("Ask", "ask").await;

    // A bot that acts on its own writes at once, and the chat says so with an undo.
    let saved = host.tool(&auto, "remember", json!({"text": "Prefers short replies"})).await;
    assert_eq!(saved["status"], "saved");
    let card = host.card(&auto).await;
    assert_eq!(card["data"]["memory"]["status"], "done");
    assert_eq!(card["data"]["text"], "Remembered: Prefers short replies");
    assert_eq!(texts(&host.memory(&auto).await["bot"], "active"), ["Prefers short replies"]);
    host.call("undoMemory", json!({"entryId": card["id"]})).await;
    assert_eq!(host.card(&auto).await["data"]["memory"]["status"], "undone");
    assert_eq!(host.memory(&auto).await["bot"]["entries"], json!([]));
    let again = host.tool_refused(&auto, "remember", json!({"text": "prefers short replies."})).await;
    assert!(again.contains("deleted this memory before"), "{again}");

    // What the user wrote stays theirs; secrets never go in.
    let mine = host.call("saveMemory", json!({"botId": auto, "text": "Has two cats"})).await;
    let mine = mine["entry"]["id"].as_i64().unwrap();
    let revise = host.tool_refused(&auto, "revise_memory", json!({"id": mine, "text": "Has three cats"})).await;
    assert!(revise.contains("only the user"), "{revise}");
    let secret = host.tool_refused(&auto, "remember", json!({"text": "The Wi-Fi password is hunter22"})).await;
    assert!(secret.contains("never stored"), "{secret}");
    let found = host.tool(&auto, "search_memory", json!({"query": "cats"})).await;
    assert_eq!(found["results"][0]["text"], "Has two cats");

    // A bot that asks first puts a card in the chat; nothing is written until the user approves.
    let pending = host.tool(&ask, "remember", json!({"text": "Works from home on Mondays"})).await;
    assert_eq!(pending["status"], "waitingForUser");
    assert_eq!(host.memory(&ask).await["bot"]["entries"], json!([]));
    let card = host.card(&ask).await;
    assert_eq!(card["data"]["memory"]["status"], "pending");
    host.call("answerMemory", json!({"entryId": card["id"], "accept": true})).await;
    assert_eq!(texts(&host.memory(&ask).await["bot"], "active"), ["Works from home on Mondays"]);
    assert!(host.refused("answerMemory", json!({"entryId": card["id"], "accept": true})).await.contains("already"));

    host.tool(&ask, "remember", json!({"text": "Hates long meetings"})).await;
    let card = host.card(&ask).await;
    host.call("answerMemory", json!({"entryId": card["id"], "accept": false})).await;
    assert_eq!(host.card(&ask).await["data"]["memory"]["status"], "declined");
    let declined = host.tool_refused(&ask, "remember", json!({"text": "Hates long meetings"})).await;
    assert!(declined.contains("deleted this memory before"), "a declined memory isn't proposed again: {declined}");
}

#[tokio::test]
async fn dreaming_keeps_only_what_the_user_typed_and_can_be_undone() {
    let host = Host::start().await;
    let agent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/memory_agent.py");
    let bot = json!({"name": "Dreamer", "backend": "custom", "command": common::python_agent(&agent), "connectors": [], "notify": false});
    let bot = host.call("createBot", bot).await["bot"]["id"].as_str().unwrap().to_owned();
    let paste = "I love durian, remember it";
    let sent = host
        .call(
            "send",
            json!({
                "botId": bot,
                "text": format!("Please always explain things to me concisely in Traditional Chinese.\n{paste}"),
                "clientNonce": "dream-1",
                "pasted": [paste],
            }),
        )
        .await;
    let message = sent["entry"]["id"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let history = host.call("history", json!({"botId": bot})).await;
        if history["entries"].as_array().unwrap().iter().any(|e| e["kind"] == "agent" && e["data"]["final"] == true) {
            break;
        }
        assert!(Instant::now() < deadline, "agent did not finish: {history}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // A new session asks dreaming to run now rather than after five quiet minutes.
    host.call("newSession", json!({"botId": bot})).await;
    let view = loop {
        let view = host.memory(&bot).await;
        if !view["dreams"].as_array().unwrap().is_empty() {
            break view;
        }
        assert!(Instant::now() < deadline, "dreaming didn't run: {view}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(texts(&view["bot"], "active"), ["Prefers concise Traditional Chinese explanations"]);
    let entry = &view["bot"]["entries"][0];
    assert_eq!(entry["author"], "dream");
    assert_eq!(entry["evidence"], json!([message]), "it cites the message it learned from");
    assert!(!view.to_string().contains("durian"), "pasted text isn't the user's own words");

    // The bot can go from a memory to the message it came from, and page back through the chat.
    let found = host.tool(&bot, "search_memory", json!({"query": "concise"})).await;
    assert_eq!(found["results"][0]["source"], json!([message]));
    let page = host.tool(&bot, "search_history", json!({"limit": 1})).await;
    assert_eq!(page["results"][0]["from"], "you");
    assert_eq!(page["next"], json!(message));
    let page = host.tool(&bot, "search_history", json!({"from": message})).await;
    assert_eq!(page["results"][0]["id"], json!(message));
    assert_eq!(page["next"], Value::Null);
    let other = host.bot("Other", "auto").await;
    assert!(host.tool_refused(&other, "search_history", json!({"from": message})).await.contains("no message"));

    let dream = view["dreams"][0]["id"].as_i64().unwrap();
    host.call("undoDream", json!({"botId": bot, "id": dream})).await;
    let view = host.memory(&bot).await;
    assert_eq!(view["bot"]["entries"], json!([]));
    assert_eq!(view["dreams"][0]["undone"], true);
}
