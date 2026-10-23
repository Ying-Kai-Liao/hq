//! Threads of terminal sessions: the kernel resolves a thread to its Claude session (`kith <agent> --resume`), and
//! the apps take a thread over from the terminal that holds it. Owner only (not on the member list).

use super::str_arg;
use crate::agent::project;
use crate::hub::Hub;
use crate::store::{EntryKind, Lane};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::ops::ControlFlow;
use std::sync::Arc;

pub(super) async fn call(hub: &Arc<Hub>, method: &str, b: Value) -> Result<ControlFlow<Value, Value>> {
    Ok(ControlFlow::Break(match method {
        // `{botId, threadId, agent, sessionId, cwd, hostBusy}` for a thread id or a session id.
        "resolveThread" => crate::terminal::resolve(hub, str_arg(&b, "thread")?).await,
        // Ends the terminal that holds the thread; refused while it works, a no-op once it is closed.
        "takeOverThread" => crate::terminal::take_over(hub, str_arg(&b, "botId")?, str_arg(&b, "threadId")?).await?,
        // `{projects, by, pinned}`: the project set the thread runs under now (by `inferred` or `person`; empty when it
        // has none or was never looked at). `pinned`: the bot's settings fix it, and neither inference nor a correction moves it.
        "threadProjects" => {
            let (lane, pinned) = place(hub, &b)?;
            match (pinned, project::read(&hub.store, &lane)) {
                (Some(pin), _) => json!({"projects": [pin], "by": "pinned", "pinned": true}),
                (None, Some(s)) => json!({"projects": s.projects, "by": s.by, "pinned": false}),
                (None, None) => json!({"projects": [], "by": "inferred", "pinned": false}),
            }
        }
        // `{botId, threadId?, projects: [id…]}`: the person's correction of the thread's project set (an empty list
        // is "no project"). It holds until the subject clearly moves again or they change it. A change writes the
        // divider notice with `projectChange.by: "person"`. Owner, or the person in their own 1:1 (see `roles::guard`).
        "setThreadProjects" => {
            let (lane, pinned) = place(hub, &b)?;
            if pinned.is_some() {
                bail!("This chat's project is set in its settings");
            }
            let mut projects: Vec<String> = Vec::new();
            for id in b["projects"].as_array().ok_or_else(|| anyhow::anyhow!("`projects` is required"))? {
                let id = id.as_str().ok_or_else(|| anyhow::anyhow!("`projects` are ids"))?;
                if !projects.iter().any(|p| p == id) {
                    projects.push(id.to_owned());
                }
            }
            let known = crate::agent::hq::projects_soon().await;
            if let Some(bad) = projects.iter().find(|p| !known.iter().any(|k| &k.id == *p)) {
                bail!("unknown project '{bad}'");
            }
            let (state, change) = project::correct(&hub.store, &lane, projects);
            if let Some(change) = &change {
                let data = json!({
                    "text": project::divider_text(&change.to),
                    "style": "divider",
                    "projectChange": project::change_data(&change.from, &change.to, "person"),
                });
                hub.add_entry(&lane, EntryKind::Notice, hub.store.max_turn(&lane.chat), &data);
            }
            json!({"projects": state.projects, "by": state.by, "changed": change.is_some()})
        }
        // Writes the thread's summary now (`kith summarise --thread`): `{written: bool}`.
        "summariseThread" => {
            let written = matches!(
                crate::chat::memory::summary::summarise_now(
                    hub,
                    str_arg(&b, "thread")?,
                    b["force"].as_bool().unwrap_or(false)
                )
                .await?,
                crate::chat::memory::summary::Wrote::Yes
            );
            serde_json::json!({"written": written})
        }
        _ => return Ok(ControlFlow::Continue(b)),
    }))
}

/// The chat and thread a call names, and the project its bot is pinned to. A group is refused: its lanes carry more
/// than one person's words, so they have no inferred project and nobody's correction to keep.
fn place(hub: &Hub, b: &Value) -> Result<(Lane, Option<String>)> {
    let bot = str_arg(b, "botId")?;
    let row = hub.store.bot(bot)?.filter(|r| !r.deleted).ok_or_else(|| anyhow::anyhow!("unknown bot"))?;
    if row.config.is_group() {
        bail!("A group's project isn't set from here");
    }
    let lane = match b["threadId"].as_str().filter(|t| !t.is_empty()) {
        Some(root) => {
            if hub.store.entry(root).is_none_or(|r| r.bot_id != bot || r.thread_id.is_some()) {
                bail!("unknown message");
            }
            Lane::in_thread(bot, root)
        }
        None => Lane::main(bot),
    };
    Ok((lane, row.config.project))
}
