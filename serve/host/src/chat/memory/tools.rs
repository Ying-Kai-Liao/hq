//! The built-in `memory` MCP server: the bot's own memory tools, and search over its chat history.

use super::dates::ymd;
use super::notices::{self, Action};
use crate::agent::acp;
use crate::hub::Hub;
use crate::store::{BotConfig, Permission};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::sync::Arc;

const SEARCH_DEFAULT: i64 = 10;
const SEARCH_MAX: i64 = 30;
const SEARCH_TERMS: usize = 8;
const SEARCH_TEXT_CHARS: usize = 1_500;

pub const INSTRUCTIONS: &str = "Your memory holds what you know about the user, and every session opens with it. \
Save lasting facts about the user with remember, and keep entries true with revise_memory and archive_memory \
(the [id] is in your instructions). Project and code knowledge belongs in the project's own files, not here. \
search_memory finds archived entries; search_history finds what was actually said in your past chats.";

pub fn tools() -> Value {
    json!([
        {
            "name": "remember",
            "description": "Save one short fact about the user to your memory: who they are, their people, preferences, standing requests, plans or commitments. Use it when the user asks you to remember something or tells you something lasting about themselves. Write one self-contained fact in the user's language, with absolute dates. The user sees it in the chat and can undo it; a bot that asks before acting shows it to the user for approval first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The fact, in one short sentence."},
                    "shared": {"type": "boolean", "description": "True for facts all the user's bots should know (name, time zone, language, important people, lasting preferences); false (default) keeps it with you."},
                },
                "required": ["text"],
            },
        },
        {
            "name": "revise_memory",
            "description": "Correct an entry of your memory, by the [id] your instructions show. Entries the user wrote can't be changed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "text": {"type": "string", "description": "The corrected fact."},
                },
                "required": ["id", "text"],
            },
        },
        {
            "name": "archive_memory",
            "description": "Take an entry out of your memory when it's no longer true, by its [id]. It stays searchable. Entries the user wrote can't be archived.",
            "inputSchema": {
                "type": "object",
                "properties": {"id": {"type": "integer"}},
                "required": ["id"],
            },
        },
        {
            "name": "search_memory",
            "description": "Search your memory, including archived entries, for text containing the query (case-insensitive).",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "search_history",
            "description": "Search your full chat history with the user for messages containing every given word (case-insensitive). Returns dated messages, newest first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words that must all appear, separated by spaces."},
                    "limit": {"type": "integer", "description": "Maximum results (default 10, at most 30)."},
                },
                "required": ["query"],
            },
            "annotations": {"readOnlyHint": true},
        },
    ])
}

pub async fn call(hub: &Arc<Hub>, bot_id: &str, name: &str, args: &Value) -> Result<Value> {
    let cfg = hub.store.bot(bot_id)?.filter(|b| !b.deleted).ok_or_else(|| anyhow!("unknown bot"))?.config;
    let text = || args["text"].as_str().map(str::to_owned).ok_or_else(|| anyhow!("text required"));
    let id = || args["id"].as_i64().ok_or_else(|| anyhow!("id required"));
    match name {
        "remember" => write(hub, &cfg, Action::Remember { text: text()?, shared: args["shared"] == true }).await,
        "revise_memory" => write(hub, &cfg, Action::Revise { entry: id()?, text: text()? }).await,
        "archive_memory" => write(hub, &cfg, Action::Archive { entry: id()? }).await,
        "search_memory" => search_memory(hub, &cfg, args["query"].as_str().unwrap_or_default()).await,
        "search_history" => search_history(hub, &cfg, args).await,
        _ => bail!("unknown memory tool: {name}"),
    }
}

/// A bot that acts without asking writes at once; one that asks puts a confirm card in the chat, unless the user's
/// own message in this turn asked it to remember.
async fn write(hub: &Arc<Hub>, cfg: &BotConfig, action: Action) -> Result<Value> {
    let hub = hub.clone();
    let cfg = cfg.clone();
    tokio::task::spawn_blocking(move || {
        let turn = hub.runtime(&cfg.id);
        let asked = turn
            .message
            .as_deref()
            .and_then(|id| hub.store.entry(id))
            .is_some_and(|e| codync_mem::evidence::asks_to_remember(&notices::typed(&e.data).join("\n")));
        if cfg.permission == Permission::Auto || asked {
            let entry = notices::apply(&hub, &cfg, turn.lane, turn.message, &action)?;
            Ok(json!({"status": "saved", "id": entry.id}))
        } else {
            notices::propose(&hub, &cfg, turn.lane, turn.message, &action)?;
            Ok(json!({"status": "waitingForUser", "note": "The user approves or declines this in the chat. Don't say it's saved."}))
        }
    })
    .await?
}

async fn search_memory(hub: &Arc<Hub>, cfg: &BotConfig, query: &str) -> Result<Value> {
    if query.trim().is_empty() {
        bail!("query required");
    }
    let (hub, bot, shared, query) = (hub.clone(), cfg.id.clone(), super::shared(cfg), query.to_owned());
    let found =
        tokio::task::spawn_blocking(move || hub.store.memory_read(|c| codync_mem::store::search(c, &bot, &query, 20)))
            .await??;
    let results: Vec<Value> = found
        .into_iter()
        .filter(|e| shared || e.bot.is_some())
        .map(|e| {
            json!({"id": e.id, "text": e.text, "state": e.state, "shared": e.bot.is_none(), "date": ymd(e.updated_at)})
        })
        .collect();
    Ok(json!({"results": results}))
}

async fn search_history(hub: &Arc<Hub>, cfg: &BotConfig, args: &Value) -> Result<Value> {
    let terms: Vec<String> =
        args["query"].as_str().unwrap_or_default().split_whitespace().take(SEARCH_TERMS).map(str::to_owned).collect();
    if terms.is_empty() {
        bail!("query must contain at least one word");
    }
    let limit = args["limit"].as_i64().unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX);
    let hub = hub.clone();
    let id = cfg.id.clone();
    let rows = tokio::task::spawn_blocking(move || hub.store.search_messages(&id, &terms, limit)).await??;
    let results: Vec<Value> = rows
        .iter()
        .map(|e| {
            json!({
                "date": ymd(e.created_at),
                "from": if e.kind == crate::store::EntryKind::User.as_str() { "user" } else { "you" },
                "inThread": e.thread_id.is_some(),
                "text": acp::truncate(e.data["text"].as_str().unwrap_or_default(), SEARCH_TEXT_CHARS),
            })
        })
        .collect();
    Ok(json!({"results": results}))
}
