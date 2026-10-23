//! Tidying for the hq agents' bots: the same triggers, evidence rules and audit as other bots (`tidy`), over the
//! agent's Markdown memory instead of kith-mem's entries. The mapping onto files is `hqmem::tidy`.
//!
//! It runs without the agent: one plain-Claude one-shot (`oneshot::one_shot_plain`), so no agent slot is taken and
//! nothing of the agent is launched. Its writes go through `hqmem` as `Who::Tidy`, so they are checked, versioned
//! and undoable like any other write to those files.

use crate::chat::oneshot::{self, Reply};
use crate::hqmem::{self, Layout, tidy as files};
use crate::hub::Hub;
use crate::store::BotConfig;
use anyhow::{Result, anyhow};
use kith_mem::tidy::{self as kd, Message};
use std::sync::Arc;
use std::time::Duration;

const COST_TIMEOUT: Duration = Duration::from_secs(15);

/// Where the memory is on this Mac.
pub(super) fn here() -> Layout {
    Layout::from_env()
}

/// Whether the agent's memory holds a dated line of the tidy-up's own that the time review may rewrite.
pub(super) fn review_due(agent: &str) -> bool {
    let layout = here();
    if files::agent_dir(&layout, agent).is_none() {
        return false;
    }
    // Only lines a run logged are the tidy-up's to rewrite, as in `tidy`.
    let Ok(written) = hqmem::open(&layout).and_then(|conn| files::written(&conn, agent)) else { return false };
    files::load(&layout, agent, "", Some(&written))
        .ok()
        .flatten()
        .is_some_and(|m| m.tidy_lines().any(super::tidy::dated))
}

/// One run over the agent's files for these conversations. True when it should be tried again later: the agent has
/// no folder here (gone), or its memory changed while the model worked.
pub(super) async fn tidy(hub: &Arc<Hub>, cfg: &BotConfig, messages: &[Message], today: &str) -> Result<bool> {
    let Some(agent) = cfg.hq_agent.clone() else { return Ok(false) };
    if hub.store.kv_get(&crate::hub::hq::gone_key(&cfg.id)).is_some() {
        return Ok(true);
    }
    let (layout, day) = (here(), today.to_owned());
    let name = agent.clone();
    let Some(material) = tokio::task::spawn_blocking(move || {
        // No folder, no history database made for it either.
        if files::agent_dir(&layout, &name).is_none() {
            return Ok(None);
        }
        let written = files::written(&hqmem::open(&layout)?, &name)?;
        files::load(&layout, &name, &day, Some(&written))
    })
    .await??
    else {
        tracing::debug!(bot = %cfg.id, agent, "no folder for the hq agent here: not tidying");
        return Ok(true);
    };
    let material = Arc::new(material);
    let (system, prompt) = kd::prompt(&material.snapshot, messages);
    let reply = oneshot::one_shot_plain(hub, &system, &prompt).await?;
    record_cost(&agent, &Tag { via: "tidy", turn: "tidy", person: None, project: None }, &reply);
    let mut plan = kd::parse(&reply.text).ok_or_else(|| anyhow!("tidying answered without a plan"))?;
    // A note belongs to the agent's own folder: the shared layer's files (people/, projects/) are the user's.
    for append in &mut plan.append {
        append.shared = false;
    }
    let (kept, rejected) = kd::audit(&material.snapshot, messages, plan);
    if !rejected.is_empty() {
        tracing::info!(bot = %cfg.id, dropped = rejected.len(), reasons = ?rejected, "tidying dropped changes");
    }
    let (m, name) = (material.clone(), agent.clone());
    let applied = tokio::task::spawn_blocking(move || {
        let conn = hqmem::open(&here())?;
        files::apply(&conn, &m, &kept)
    })
    .await??;
    if applied.stale {
        return Ok(true);
    }
    if !applied.dropped.is_empty() {
        tracing::info!(bot = %cfg.id, dropped = applied.dropped.len(), reasons = ?applied.dropped, "tidying dropped file changes");
    }
    if let Some(run) = applied.tidy {
        tracing::info!(bot = %cfg.id, agent = name, run, files = applied.versions.len(), "memory files tidied");
        hub.emit_bot(&cfg.id);
    }
    Ok(false)
}

/// How a background run is tagged in the cost ledger: `via` (what kind of run), and for a run done for a person or
/// a project, who and which (`KITH_PERSON`, `KITH_PROJECT`, as for a run of that person's).
pub(super) struct Tag<'a> {
    pub via: &'a str,
    pub turn: &'a str,
    pub person: Option<&'a str>,
    pub project: Option<&'a str>,
}

/// Writes the run's tokens to the agent's cost ledger (`kith cost record`). Nothing when the agent didn't report
/// tokens; a failure is logged and never fails the run.
pub(super) fn record_cost(agent: &str, tag: &Tag, reply: &Reply) {
    let Some(usage) = reply.usage else {
        tracing::debug!(agent, "the one-shot reported no token usage: no cost row for this tidy");
        return;
    };
    let row = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(), "session": reply.session, "model": "haiku", "turn": tag.turn,
        "input": usage.input, "output": usage.output, "cache_read": usage.cache_read,
        "cache_write": usage.cache_write, "cost": null,
    });
    let agent = agent.to_owned();
    let (via, person, project) = (tag.via.to_owned(), tag.person.map(str::to_owned), tag.project.map(str::to_owned));
    tokio::spawn(async move {
        let result = async {
            let bin = tokio::task::spawn_blocking(crate::agent::hq::bin)
                .await?
                .ok_or_else(|| anyhow!("no kith to record with"))?;
            let mut child = tokio::process::Command::new(bin)
                .args(["cost", "record"])
                .env("KITH_AGENT", &agent)
                .env("KITH_VIA", &via)
                .env("KITH_PERSON", person.as_deref().unwrap_or_default())
                .env("KITH_PROJECT", project.as_deref().unwrap_or_default())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()?;
            if let Some(mut stdin) = child.stdin.take() {
                tokio::io::AsyncWriteExt::write_all(&mut stdin, row.to_string().as_bytes()).await?;
            }
            tokio::time::timeout(COST_TIMEOUT, child.wait()).await??;
            anyhow::Ok(())
        }
        .await;
        if let Err(e) = result {
            tracing::warn!(agent, error = format!("{e:#}"), "couldn't record a background run's cost");
        }
    });
}
