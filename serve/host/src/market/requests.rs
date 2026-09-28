//! Durable, non-secret connection requests. Only the client submits credentials;
//! tools receive status, never credential values.
use super::connectors;
use crate::{
    agent::bot::Cmd,
    hub::Hub,
    store::{Entry, EntryKind, Lane, now_ms},
};
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

pub const INSTRUCTIONS: &str = "Connect external services with search_connectors, list_connectors and request_connection. To update an installed connector's key use request_secret. Requests appear as secure cards in the user's conversation. Never ask for passwords or keys in ordinary chat or tool arguments. After requesting, finish your turn and wait; Codync resumes you after the user completes setup.";
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RequestKind {
    Connection,
    Secret,
    App,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RequestStatus {
    Pending,
    Ready,
    Cancelled,
}

fn has_status(request: &Value, status: RequestStatus) -> bool {
    serde_json::from_value::<RequestStatus>(request["status"].clone()).ok() == Some(status)
}

const MAX_AGE: i64 = 24 * 60 * 60 * 1000;
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn tools() -> Value {
    json!([
        {"name":"search_connectors","description":"Find registry connectors by service name.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}},
        {"name":"list_connectors","description":"List installed connectors without credentials.","inputSchema":{"type":"object","properties":{}}},
        {"name":"request_connection","description":"Invite the user to install or authorize a connector. Supply either registryName from search or connectorId from the installed list.","inputSchema":{"type":"object","properties":{"registryName":{"type":"string"},"connectorId":{"type":"string"},"reason":{"type":"string"}},"required":["reason"]}},
        {"name":"request_app","description":"Invite the user to connect a hosted app through Composio, for example gmail or slack.","inputSchema":{"type":"object","properties":{"toolkit":{"type":"string"},"reason":{"type":"string"}},"required":["toolkit","reason"]}},
        {"name":"request_secret","description":"Ask the user to securely provide a credential for an installed connector. The value goes directly to that connector and is never returned to you.","inputSchema":{"type":"object","properties":{"connectorId":{"type":"string"},"field":{"type":"string"},"location":{"type":"string","enum":["env","header"]},"reason":{"type":"string"}},"required":["connectorId","field","location","reason"]}}
    ])
}

pub async fn call(hub: &Arc<Hub>, bot: &str, name: &str, args: &Value) -> Result<Value> {
    hub.store.bot(bot)?.filter(|b| !b.deleted && !b.config.is_group()).ok_or_else(|| anyhow!("unknown bot"))?;
    match name {
        "search_connectors" => super::browse_connectors(&hub.store, text(args, "query")?, "").await,
        "list_connectors" => super::list_connectors(&hub.store),
        "request_app" => {
            let toolkit = text(args, "toolkit")?.to_ascii_lowercase();
            if toolkit.len() > 100 || !toolkit.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
                bail!("Invalid app identifier");
            }
            let lane = hub.runtime(bot).lane.unwrap_or_else(|| Lane::main(bot));
            let reason: String = text(args, "reason")?.chars().take(400).collect();
            let entry = hub.add_entry(&lane,EntryKind::Notice,hub.store.max_turn(bot),&json!({"text":reason,"connectionRequest":{
                "kind":RequestKind::App,"status":RequestStatus::Pending,"title":toolkit,"botId":bot,"toolkit":toolkit,"connectorId":format!("{}{}",super::composio::PREFIX,toolkit)
            }})).ok_or_else(|| anyhow!("Could not save connection request"))?;
            Ok(json!({"requestId":entry.id,"status":"waitingForUser"}))
        }
        "request_connection" | "request_secret" => {
            let installed = args["connectorId"].as_str().filter(|s| !s.is_empty());
            let (title, registry) = if let Some(id) = installed {
                let c = connectors(&hub.store)?
                    .into_iter()
                    .find(|c| c.id == id)
                    .ok_or_else(|| anyhow!("unknown connector"))?;
                (c.name, c.registry_name)
            } else {
                let registry = text(args, "registryName")?;
                let item = super::connector_info(&hub.store, registry).await?;
                (item["title"].as_str().unwrap_or(registry).to_owned(), Some(registry.to_owned()))
            };
            let secret = name == "request_secret";
            if secret {
                if installed.is_none() {
                    bail!("A secret request needs an installed connector");
                }
                let field = text(args, "field")?;
                if field.len() > 128 || !field.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                    bail!("Invalid credential field");
                }
                if !matches!(text(args, "location")?, "env" | "header") {
                    bail!("Invalid credential destination");
                }
            }
            let lane = hub.runtime(bot).lane.unwrap_or_else(|| Lane::main(bot));
            let request = json!({"kind":if secret {RequestKind::Secret} else {RequestKind::Connection}, "status":RequestStatus::Pending, "title":title,
                "registryName":registry, "connectorId":installed, "botId":bot,
                "field":if secret {args["field"].clone()} else {Value::Null},
                "location":if secret {args["location"].clone()} else {Value::Null}});
            let reason: String = text(args, "reason")?.chars().take(400).collect();
            let entry = hub
                .add_entry(
                    &lane,
                    EntryKind::Notice,
                    hub.store.max_turn(bot),
                    &json!({"text":reason,"connectionRequest":request}),
                )
                .ok_or_else(|| anyhow!("Could not save connection request"))?;
            Ok(json!({"requestId":entry.id,"status":"waitingForUser"}))
        }
        _ => bail!("Unknown connection tool"),
    }
}

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("{key} is required"))
}

fn pending(hub: &Hub, id: &str, cancelling: bool) -> Result<Entry> {
    let e = hub.store.entry(id).ok_or_else(|| anyhow!("Unknown connection request"))?;
    if !has_status(&e.data["connectionRequest"], RequestStatus::Pending) {
        bail!("This request is already completed or cancelled");
    }
    if !cancelling && now_ms() - e.created_at > MAX_AGE {
        bail!("This request expired. Ask the bot for a new request.");
    }
    let bot = text(&e.data["connectionRequest"], "botId")?;
    hub.store.bot(bot)?.filter(|b| !b.deleted).ok_or_else(|| anyhow!("The requesting bot was removed"))?;
    Ok(e)
}

pub async fn finish(hub: &Arc<Hub>, args: &Value) -> Result<Value> {
    let _guard = MUTATION.lock().await;
    let id = text(args, "entryId")?;
    if let Some(entry) = hub.store.entry(id)
        && has_status(&entry.data["connectionRequest"], RequestStatus::Ready)
    {
        return Ok(json!({"entry":entry}));
    }
    let e = pending(hub, id, args["cancel"] == true)?;
    let request = &e.data["connectionRequest"];
    let kind: RequestKind = serde_json::from_value(request["kind"].clone())?;
    if args["cancel"] == true {
        let mut data = e.data.clone();
        data["connectionRequest"]["status"] = serde_json::to_value(RequestStatus::Cancelled)?;
        return Ok(json!({"entry":hub.set_entry(id, &data).ok_or_else(|| anyhow!("Could not cancel request"))?}));
    }
    let connector_id = request["connectorId"]
        .as_str()
        .or(args["connectorId"].as_str())
        .ok_or_else(|| anyhow!("Choose a connector"))?;
    if kind != RequestKind::App {
        super::update_connectors(&hub.store, |all| {
            let c = all.iter_mut().find(|c| c.id == connector_id).ok_or_else(|| anyhow!("Unknown connector"))?;
            if request["connectorId"].is_null() && request["registryName"].as_str() != c.registry_name.as_deref() {
                bail!("This connector does not match the request");
            }
            if kind == RequestKind::Secret {
                let value = text(args, "value")?;
                if value.len() > 64 * 1024 {
                    bail!("Credential is too large");
                }
                let field = text(request, "field")?.to_owned();
                match text(request, "location")? {
                    "env" if c.command.is_some() => {
                        c.env.insert(field, value.to_owned());
                    }
                    "header" if c.url.is_some() => {
                        c.headers.insert(field, value.to_owned());
                    }
                    _ => bail!("Credential destination does not match this connector"),
                }
            }
            Ok(())
        })?;
    }
    super::verify::verify(&hub.store, connector_id, hub.port).await?;
    let bot = text(request, "botId")?;
    let row = hub.store.bot(bot)?.ok_or_else(|| anyhow!("Unknown bot"))?;
    let mut enabled = row.config.connectors;
    if !enabled.iter().any(|s| s == connector_id) {
        enabled.push(connector_id.to_owned());
    }
    hub.update_bot(&json!({"id":bot,"connectors":enabled}))?;
    hub.send_cmd(bot, Cmd::RefreshTools)?;
    let mut data = e.data.clone();
    data["connectionRequest"]["status"] = serde_json::to_value(RequestStatus::Ready)?;
    let entry = hub.set_entry(id, &data).ok_or_else(|| anyhow!("Could not complete request"))?;
    let lane = Lane { chat: e.bot_id, thread: e.thread_id };
    let text = format!(
        "[Connection setup completed: {}. Credentials were submitted securely and are not in this conversation. Continue the task.]",
        request["title"].as_str().unwrap_or("Connector")
    );
    let (ack, added) = hub.add_entry_once(
        &format!("connection-ack-{id}"),
        &lane,
        EntryKind::User,
        &json!({"text":text,"status":"queued"}),
    )?;
    if added {
        hub.send_cmd(bot, Cmd::Send { lane, entry_id: ack.id, text })?;
    }
    Ok(json!({"entry":entry}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{BotConfig, Store};
    use std::path::{Path, PathBuf};

    fn fixture() -> (Arc<Hub>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("codync-credentials-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(Path::new(":memory:")).unwrap();
        let agent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/team_agent.py");
        let cfg: BotConfig = serde_json::from_value(json!({"id":"bot","name":"bot","backend":"fixture","cwd":dir,"command":format!("python3 -u '{}'",agent.display()),"notify":false})).unwrap();
        store.save_bot(&cfg).unwrap();
        let c: super::super::Connector = serde_json::from_value(json!({"id":"fixture","name":"Fixture","command":"python3","args":[PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/credential_mcp.py")]})).unwrap();
        super::super::save_connectors(&store, &[c]).unwrap();
        let hub = Hub::new(
            store,
            "test".into(),
            crate::remote::identity::Identity::load_or_create(&dir).unwrap(),
            "test".into(),
            19222,
        );
        hub.start().unwrap();
        (hub, dir)
    }

    #[tokio::test]
    async fn secure_submission_enables_connector_and_resumes_only_once() {
        let (hub, dir) = fixture();
        let r = call(
            &hub,
            "bot",
            "request_secret",
            &json!({"connectorId":"fixture","field":"API_KEY","location":"env","reason":"Connect the test service"}),
        )
        .await
        .unwrap();
        let id = r["requestId"].as_str().unwrap();
        let submitted = json!({"entryId":id,"value":"test-private-key"});
        let first = finish(&hub, &submitted).await.unwrap();
        assert_eq!(first["entry"]["data"]["connectionRequest"]["status"], "ready");
        assert!(!first.to_string().contains("test-private-key"));
        assert!(hub.store.bot("bot").unwrap().unwrap().config.connectors.contains(&"fixture".to_owned()));
        assert!(!hub.store.kv_read("connectors").unwrap().unwrap().contains("test-private-key"));
        finish(&hub, &submitted).await.unwrap();
        let history = hub.store.history("bot", i64::MAX, 100).unwrap();
        assert_eq!(history.iter().filter(|e| e.id == format!("connection-ack-{id}")).count(), 1);
        assert!(!serde_json::to_string(&history).unwrap().contains("test-private-key"));
        hub.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_control_devices_cannot_retrieve_credentials_or_forge_requests() {
        let caller =
            crate::api::devices::Caller::Device { key: "test".into(), scopes: vec![crate::store::Scope::Control] };
        for method in ["connectorRuntime", "connectorTarget", "connectorCall"] {
            assert!(crate::api::devices::permit(&caller, method).is_err());
        }
        assert!(crate::api::devices::permit(&caller, "connectorRequestFinish").is_ok());
    }

    #[tokio::test]
    async fn cancellation_rejects_later_secret_submission() {
        let (hub, dir) = fixture();
        let r = call(
            &hub,
            "bot",
            "request_secret",
            &json!({"connectorId":"fixture","field":"API_KEY","location":"env","reason":"Test"}),
        )
        .await
        .unwrap();
        let id = &r["requestId"];
        finish(&hub, &json!({"entryId":id,"cancel":true})).await.unwrap();
        assert!(finish(&hub, &json!({"entryId":id,"value":"test-private-key"})).await.is_err());
        assert!(connectors(&hub.store).unwrap()[0].env.is_empty());
        hub.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn failed_verification_does_not_enable_connector_or_resume() {
        let (hub, dir) = fixture();
        let r = call(
            &hub,
            "bot",
            "request_secret",
            &json!({"connectorId":"fixture","field":"API_KEY","location":"env","reason":"Test"}),
        )
        .await
        .unwrap();
        let id = r["requestId"].as_str().unwrap();
        assert!(finish(&hub, &json!({"entryId":id,"value":"wrong"})).await.is_err());
        assert_eq!(hub.store.entry(id).unwrap().data["connectionRequest"]["status"], "pending");
        assert!(hub.store.bot("bot").unwrap().unwrap().config.connectors.is_empty());
        assert!(hub.store.entry(&format!("connection-ack-{id}")).is_none());
        hub.shutdown().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
