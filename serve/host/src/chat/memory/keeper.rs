//! The bot's memory keeper: queued exchanges, the one-shot agent runs that remember them,
//! episodes and profile consolidation.

use super::extract::{
    EpisodeTurn, apply, consolidation_system_prompt, consolidation_user_prompt, episode_system_prompt,
    episode_user_prompt, existing_for_extraction, extraction_system_prompt, extraction_user_prompt, parse_extraction,
    pending_episode, set_pending_episode,
};
use super::facts::{Kind, Memory, dedupe_key, normalize};
use super::{
    EPISODE_INTERVAL, EPISODE_PREFIX, EXCHANGE_CHARS, KEEPER_BATCH, KEEPER_IDLE, KEEPER_TIMEOUT, NONE,
    PROFILE_PROMPT_LIMIT,
};
use crate::agent::acp::{self, Acp, Incoming};
use crate::hub::Hub;
use crate::store::{BotConfig, Store};
use anyhow::{Result, anyhow, bail};
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// A finished user ↔ agent exchange worth remembering.
pub struct Exchange {
    pub user: String,
    pub agent: String,
    pub at: i64,
}

fn unprocessed_key(bot_id: &str) -> String {
    format!("memory.unprocessed.{bot_id}")
}

fn unprocessed(store: &Store, bot_id: &str) -> Vec<EpisodeTurn> {
    store.kv_get(&unprocessed_key(bot_id)).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

/// Starts the bot's keeper. Exchanges queue up (persisted, so a restart keeps them)
/// and are remembered together once the bot has been quiet for [`KEEPER_IDLE`] or
/// [`KEEPER_BATCH`] have piled up: the frozen prompt only picks facts up at the next
/// compaction or session anyway, and one run over several exchanges sees their
/// context. An unnamed bot is named right away (see `naming`). It stops when the
/// bot actor drops the sender; what's queued is picked up by the next keeper.
pub fn spawn_keeper(hub: Arc<Hub>, bot_id: String) -> mpsc::UnboundedSender<Exchange> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Exchange>();
    tokio::spawn(async move {
        let mut queued = unprocessed(&hub.store, &bot_id);
        let idle = tokio::time::sleep(KEEPER_IDLE);
        tokio::pin!(idle);
        loop {
            let flush = tokio::select! {
                x = rx.recv() => {
                    let Some(x) = x else { break };
                    let turn = EpisodeTurn {
                        ts: x.at,
                        user: acp::truncate(&x.user, EXCHANGE_CHARS),
                        agent: acp::truncate(&x.agent, EXCHANGE_CHARS),
                    };
                    if let Err(e) = crate::chat::naming::observe(&hub, &bot_id, turn.clone()).await {
                        tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "naming the bot failed");
                    }
                    // Re-read: another keeper of this bot (before a restart) may have flushed.
                    queued = unprocessed(&hub.store, &bot_id);
                    queued.push(turn);
                    if let Err(e) = hub.store.kv_set(&unprocessed_key(&bot_id), &serde_json::to_string(&queued).unwrap_or_default()) {
                        tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "couldn't queue an exchange for memory");
                    }
                    idle.as_mut().reset(tokio::time::Instant::now() + KEEPER_IDLE);
                    queued.len() >= KEEPER_BATCH
                }
                () = &mut idle, if !queued.is_empty() => true,
            };
            if !flush {
                continue;
            }
            let batch = std::mem::take(&mut queued);
            // Cleared before the run: a failing agent must not retry the same batch forever.
            if let Err(e) = hub.store.kv_set(&unprocessed_key(&bot_id), "[]") {
                tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "couldn't clear the memory queue");
            }
            if let Err(e) = remember(&hub, &bot_id, batch).await {
                tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "memory keeper failed");
            }
        }
    });
    tx
}

async fn remember(hub: &Arc<Hub>, bot_id: &str, turns: Vec<EpisodeTurn>) -> Result<()> {
    let Some(cfg) = hub.store.bot(bot_id)?.filter(|b| !b.deleted).map(|b| b.config) else { return Ok(()) };
    let Some(at) = turns.last().map(|t| t.ts) else { return Ok(()) };

    let id = bot_id.to_owned();
    let exchange_text = turns.iter().map(|t| format!("{}\n{}", t.user, t.agent)).collect::<Vec<_>>().join("\n");
    let existing = tokio::task::spawn_blocking(move || {
        Memory::for_bot(&id).map(|mem| existing_for_extraction(&mem, &exchange_text))
    })
    .await??;
    let raw = one_shot(hub, &cfg, &extraction_system_prompt(), &extraction_user_prompt(&turns, &existing)).await?;
    let extraction = parse_extraction(&raw, &existing);
    let id = bot_id.to_owned();
    let (added, removed, crowded) = tokio::task::spawn_blocking(move || {
        Memory::for_bot(&id).and_then(|mem| {
            let (added, removed) = apply(&mem, &extraction, &existing, at)?;
            Ok((added, removed, mem.profile_facts().len() > PROFILE_PROMPT_LIMIT))
        })
    })
    .await??;
    tracing::info!(bot = %bot_id, exchanges = turns.len(), added, removed, "memory updated");
    if crowded && let Err(e) = consolidate(hub, &cfg).await {
        tracing::warn!(bot = %bot_id, error = format!("{e:#}"), "consolidating the profile failed");
    }

    let mut pending = pending_episode(&hub.store, bot_id);
    pending.extend(turns);
    if pending.len() < EPISODE_INTERVAL {
        return set_pending_episode(&hub.store, bot_id, &pending);
    }
    set_pending_episode(&hub.store, bot_id, &[])?;
    let raw = one_shot(hub, &cfg, &episode_system_prompt(&cfg.name), &episode_user_prompt(&cfg.name, &pending)).await?;
    let narrative = normalize(&raw);
    if !narrative.is_empty() && !narrative.eq_ignore_ascii_case(NONE) {
        let at = pending.last().map_or(at, |t| t.ts);
        let id = bot_id.to_owned();
        tokio::task::spawn_blocking(move || {
            Memory::for_bot(&id).and_then(|mem| mem.add(&format!("{EPISODE_PREFIX}{narrative}"), Kind::Log, at))
        })
        .await??;
    }
    Ok(())
}

/// The profile outgrew what the prompt shows: have the keeper merge it down to
/// [`PROFILE_TARGET`] facts. Nothing is lost: facts it drops move to the log.
async fn consolidate(hub: &Arc<Hub>, cfg: &BotConfig) -> Result<()> {
    let id = cfg.id.clone();
    let facts = tokio::task::spawn_blocking(move || Memory::for_bot(&id).map(|m| m.profile_facts())).await??;
    let raw = one_shot(hub, cfg, &consolidation_system_prompt(), &consolidation_user_prompt(&facts)).await?;
    let plan = parse_extraction(&raw, &[]);
    let keep: Vec<&String> = plan.additions.iter().filter(|(_, k)| *k == Kind::Profile).map(|(c, _)| c).collect();
    if keep.is_empty() || keep.len() > PROFILE_PROMPT_LIMIT {
        bail!("the consolidated profile had {} facts", keep.len());
    }
    let now = crate::store::now_ms();
    let dated = |c: &str| facts.iter().find(|f| dedupe_key(&f.content) == dedupe_key(c)).map_or(now, |f| f.created_at);
    let kept: Vec<(String, i64)> = keep.iter().map(|c| ((*c).clone(), dated(c))).collect();
    let kept_keys: HashSet<String> = kept.iter().map(|(c, _)| dedupe_key(c)).collect();
    let mut demoted: Vec<(String, i64)> = facts
        .iter()
        .filter(|f| !kept_keys.contains(&dedupe_key(&f.content)))
        .map(|f| (f.content.clone(), f.created_at))
        .collect();
    demoted.extend(plan.additions.iter().filter(|(_, k)| *k == Kind::Log).map(|(c, _)| (c.clone(), now)));
    let id = cfg.id.clone();
    let (before, after) = (facts.len(), kept.len());
    tokio::task::spawn_blocking(move || Memory::for_bot(&id).and_then(|m| m.rewrite_profile(&kept, &demoted)))
        .await??;
    tracing::info!(bot = %cfg.id, before, after, "profile consolidated");
    Ok(())
}

/// Runs one prompt on a throwaway agent of the bot's harness and returns its reply.
/// Claude gets a real system prompt, no tools, no settings and no saved session;
/// other harnesses get the instructions inline.
pub(crate) async fn one_shot(hub: &Arc<Hub>, cfg: &BotConfig, system: &str, user: &str) -> Result<String> {
    let cwd = crate::service::data_dir().join("memory-keeper");
    tokio::fs::create_dir_all(&cwd).await?;
    let cwd = cwd.to_string_lossy().into_owned();
    if hub.store.kv_read(&format!("agent-env:{}", cfg.backend))?.is_some() {
        crate::market::vault::unlock(hub.clone()).await?;
    }
    let env = crate::agent::auth::env(&hub.store, &cfg.backend)?;
    let mut conn = None;
    let mut last_err = None;
    for command in crate::agent::bot::launch_commands(cfg, |_| {}).await? {
        match crate::agent::bot::start_agent(&command, &cwd, &env, Duration::from_secs(60)).await {
            Ok(c) => {
                conn = Some(c);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let mut conn = conn.ok_or_else(|| last_err.unwrap_or_else(|| anyhow!("no agent to run the memory keeper")))?;
    let acp = conn.acp.clone();
    let result = async {
        let mut params = json!({"cwd": cwd, "mcpServers": []});
        let text = if conn.claude {
            params["_meta"] = json!({
                "systemPrompt": system,
                "claudeCode": {"options": {"tools": [], "persistSession": false, "settingSources": [], "model": "haiku"}},
            });
            user.to_owned()
        } else {
            format!("{system}\n\n---\n\n{user}")
        };
        let res = acp.request("session/new", params).await?;
        let sid = res["sessionId"].as_str().ok_or_else(|| anyhow!("agent returned no sessionId"))?.to_owned();
        // Same model as the bot: the harness default may be another (local) model that
        // would load next to the bot's, or a cloud one the user kept these chats away from.
        if !conn.claude {
            crate::agent::bot::select_model(&acp, &res, &sid, cfg).await?;
        }
        let prompt = acp.request("session/prompt", json!({"sessionId": sid, "prompt": [{"type": "text", "text": text}]}));
        tokio::pin!(prompt);
        let deadline = tokio::time::sleep(KEEPER_TIMEOUT);
        tokio::pin!(deadline);
        let mut out = String::new();
        loop {
            tokio::select! {
                r = &mut prompt => { r?; break }
                inc = conn.rx.recv() => {
                    if !collect(&acp, inc, &mut out).await {
                        bail!("the memory keeper's agent exited");
                    }
                }
                () = &mut deadline => bail!("the memory keeper timed out"),
            }
        }
        while let Ok(inc) = conn.rx.try_recv() {
            collect(&acp, Some(inc), &mut out).await;
        }
        Ok(out)
    }
    .await;
    acp.kill().await;
    result
}

/// Keeps reply text; refuses anything the agent asks of us. False once the agent is gone.
async fn collect(acp: &Acp, inc: Option<Incoming>, out: &mut String) -> bool {
    match inc {
        None | Some(Incoming::Closed { .. }) => false,
        Some(Incoming::Notification { method, params }) => {
            let u = &params["update"];
            if method == "session/update" && u["sessionUpdate"] == "agent_message_chunk" {
                out.push_str(&acp::content_text(&u["content"]));
            }
            true
        }
        Some(Incoming::Request { id, method, .. }) => {
            let _ = if method == "session/request_permission" {
                acp.respond(id, json!({"outcome": {"outcome": "cancelled"}})).await
            } else {
                acp.respond_error(id, -32601, "not supported").await
            };
            true
        }
    }
}
