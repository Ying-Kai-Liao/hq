//! The built-in `memory` MCP server: the bot's own memory tools, and search over its chat history.

use super::dates::ymd;
use super::notices::{self, Action};
use crate::agent::acp;
use crate::hub::Hub;
use crate::store::BotConfig;
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
Lists, itineraries, histories and other detail longer than a sentence or two go in a long-form note on that topic \
(listed in your instructions), not in entries. search_memory finds archived entries and lines of those notes; \
search_history finds what was actually said in your past chats. When the user asks you to forget something, \
take it out of entries and notes, and don't bring it back from your chat history either.";

pub fn tools() -> Value {
    let mut tools = json!([
        {
            "name": "remember",
            "description": "Save one short fact about the user to your memory: who they are, their people, preferences, standing requests, plans or commitments. Use it when the user asks you to remember something or tells you something lasting about themselves. Write one self-contained fact in the user's language, with absolute dates. The user sees all of it in the bot's memory settings and changes or deletes it there.",
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
            "description": "Search your memory, including archived entries and your long-form files, for text containing the query (case-insensitive). Each entry's source lists the messages it was learned from: pass one to search_history as from to read it. files lists matching lines of your memory files.",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "search_history",
            "description": "Read your full chat history with the user, newest first: messages containing every given word (case-insensitive), or without a query, every message. Returns dated messages with ids, and next: pass it as from for the page before.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words that must all appear, separated by spaces."},
                    "from": {"type": "string", "description": "A message id (from a result, next, or a memory's source): start at that message and go back."},
                    "limit": {"type": "integer", "description": "Maximum results (default 10, at most 30)."},
                },
            },
            "annotations": {"readOnlyHint": true},
        },
    ]);
    if let Some(list) = tools.as_array_mut() {
        list.extend(super::file_tools::definitions());
    }
    tools
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
        "read_memory" | "edit_memory" => super::file_tools::call(hub, &cfg, name, args).await,
        _ => bail!("unknown memory tool: {name}"),
    }
}

/// Writes at once, whatever the bot's permission: memory isn't an action on the user's computer, and the user
/// reviews and changes it in the bot's memory settings.
async fn write(hub: &Arc<Hub>, cfg: &BotConfig, action: Action) -> Result<Value> {
    let hub = hub.clone();
    let cfg = cfg.clone();
    tokio::task::spawn_blocking(move || {
        let turn = hub.runtime(&cfg.id);
        let before = super::current_revision(&hub.store, &cfg.id);
        let entry = notices::apply(&hub, &cfg, turn.lane, turn.message, &action)?;
        // The session that wrote it needs no notice about its own write.
        if let Some(session) = &turn.session
            && let Err(error) = super::heard_own_write(&hub.store, &cfg.id, session, &before)
        {
            tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't record the bot's own write");
        }
        Ok(json!({"status": "saved", "id": entry.id}))
    })
    .await?
}

async fn search_memory(hub: &Arc<Hub>, cfg: &BotConfig, query: &str) -> Result<Value> {
    if query.trim().is_empty() {
        bail!("query required");
    }
    let (hub, bot, shared, query) = (hub.clone(), cfg.id.clone(), super::shared(cfg), query.to_owned());
    let (found, lines) = tokio::task::spawn_blocking(move || {
        hub.store.memory_read(|c| {
            let entries = codync_mem::store::search(c, &bot, &query, 20)?;
            Ok((entries, codync_mem::files::search(c, &bot, shared, &query, 20)?))
        })
    })
    .await??;
    let files: Vec<Value> = lines
        .into_iter()
        .map(|hit| {
            json!({"file": hit.name, "shared": hit.bot.is_none(), "line": hit.line, "text": acp::truncate(&hit.text, 300)})
        })
        .collect();
    let results: Vec<Value> = found
        .into_iter()
        .filter(|e| shared || e.bot.is_some())
        .map(|e| {
            json!({
                "id": e.id,
                "text": e.text,
                "state": e.state,
                "shared": e.bot.is_none(),
                "date": ymd(e.updated_at),
                "source": e.evidence,
            })
        })
        .collect();
    Ok(json!({"results": results, "files": files}))
}

async fn search_history(hub: &Arc<Hub>, cfg: &BotConfig, args: &Value) -> Result<Value> {
    let terms: Vec<String> =
        args["query"].as_str().unwrap_or_default().split_whitespace().take(SEARCH_TERMS).map(str::to_owned).collect();
    let from = args["from"].as_str().map(str::to_owned);
    let limit = args["limit"].as_i64().unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX);
    let hub = hub.clone();
    let bot = cfg.id.clone();
    let (rows, next) = tokio::task::spawn_blocking(move || -> Result<_> {
        let from = match from {
            Some(id) => Some(
                hub.store
                    .entry(&id)
                    .filter(|e| e.bot_id == bot)
                    .ok_or_else(|| anyhow!("no message {id} in your chat"))?
                    .seq,
            ),
            None => None,
        };
        // One more than asked tells whether there is a page before.
        let mut rows = hub.store.search_messages(&bot, &terms, from, limit + 1)?;
        let next = if rows.len() > usize::try_from(limit)? { rows.pop().map(|e| e.id) } else { None };
        Ok((rows, next))
    })
    .await??;
    let results: Vec<Value> = rows
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "date": ymd(e.created_at),
                "from": if e.kind == crate::store::EntryKind::User.as_str() { "user" } else { "you" },
                "inThread": e.thread_id.is_some(),
                "text": acp::truncate(e.data["text"].as_str().unwrap_or_default(), SEARCH_TEXT_CHARS),
            })
        })
        .collect();
    Ok(json!({"results": results, "next": next}))
}
