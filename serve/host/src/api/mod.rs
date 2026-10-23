//! HTTP API: `POST /api/<method>` commands + `GET /events` SSE for this computer's own
//! apps and helpers (loopback + `Authorization: Bearer <token>`), and `GET /channel`, the
//! direct end-to-end encrypted channel phones use (see `channel`).

mod backups;
mod bots;
pub mod devices;
mod events;
mod files;
mod folders;
mod host;
mod http;
mod kith_info;
mod marketplace;
mod people;
#[cfg(test)]
mod proof_tests;
mod remote;
#[cfg(test)]
pub(crate) mod rig;
pub mod roles;
#[cfg(test)]
mod roles_tests;

pub use events::{events_stream, term_events};
pub use http::router;

use crate::api::devices::{Caller, Forbidden, NotAllowed, Principal};
use crate::hub::Hub;
use crate::market;
use anyhow::{Result, anyhow};
use axum::http::StatusCode;
use serde_json::Value;
use std::ops::ControlFlow;
use std::sync::Arc;

/// `POST /api/<method>` with a method this host doesn't know (404, not 400).
#[derive(Debug)]
struct UnknownMethod;

impl std::fmt::Display for UnknownMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("unknown method")
    }
}

impl std::error::Error for UnknownMethod {}

/// HTTP status and message for a failed call; channels send the same pair in `err`.
pub fn error_status(e: &anyhow::Error) -> (StatusCode, String) {
    if e.is::<UnknownMethod>() {
        (StatusCode::NOT_FOUND, e.to_string())
    } else if e.is::<Forbidden>() || e.is::<NotAllowed>() {
        (StatusCode::FORBIDDEN, e.to_string())
    } else if e.is::<crate::remote::cloud::Conflict>() {
        (StatusCode::CONFLICT, e.to_string())
    } else {
        // `{:#}` keeps the context chain ("starting `npx …`: No such file or directory").
        (StatusCode::BAD_REQUEST, format!("{e:#}"))
    }
}

fn str_arg<'a>(b: &'a Value, k: &str) -> Result<&'a str> {
    b[k].as_str().ok_or_else(|| anyhow!("`{k}` is required"))
}

/// The actor a built-in tool call came from (`actor`, set by `mcp.rs`), when it is one of `bot`'s; else its own chat's.
fn actor_arg<'a>(b: &'a Value, bot: &'a str) -> &'a str {
    b["actor"].as_str().filter(|a| crate::agent::bot::bot_of(a) == bot).unwrap_or(bot)
}

/// Runs one API method for `caller` (permissions per spec §6.6).
pub async fn dispatch(hub: &Arc<Hub>, caller: &Caller, method: &str, b: Value) -> Result<Value> {
    let permitted = devices::permit(caller, method);
    match devices::principal(&hub.store, caller) {
        Principal::Owner => permitted?,
        Principal::Nobody => return Err(Forbidden.into()),
        Principal::Member(person) => return member_call(hub, caller, &person, true, method, b, permitted).await,
        Principal::Unproven(person) => return member_call(hub, caller, &person, false, method, b, permitted).await,
    }
    let observed = crate::analytics::observe_call(hub, caller, method, &b);
    let result = route(hub, caller, method, b).await;
    if result.is_ok()
        && let Some((event, properties)) = observed
    {
        crate::analytics::capture(hub, event, properties);
    }
    result
}

async fn route(hub: &Arc<Hub>, caller: &Caller, method: &str, b: Value) -> Result<Value> {
    if method.contains("onnector")
        || method.starts_with("composio")
        || method == "setComposioKey"
        || method.starts_with("credential")
        // Only signing in reads the vault; other computer tools work without a keyring.
        || (method == "computerCall" && b["name"] == "type_login")
        // The on-computer voice needs no key.
        || (method.starts_with("voice") && !method.starts_with("voiceLocal"))
        || method == "setVoiceKey"
        || matches!(method, "agentAuth" | "agentAuthenticate" | "setAgentEnv")
    {
        market::vault::unlock(hub.clone()).await?;
    }
    if method == "readFile" {
        return files::read(hub, &b).await;
    }
    // Each method group answers its own methods and hands the body back otherwise.
    let b = match host::call(hub, caller, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    let b = match folders::call(hub, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    let b = match backups::call(hub, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    let b = match kith_info::call(hub, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    let b = match marketplace::call(hub, caller, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    let b = match bots::call(hub, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    let b = match people::call(hub, caller, method, b).await? {
        ControlFlow::Break(v) => return Ok(v),
        ControlFlow::Continue(b) => b,
    };
    match remote::call(hub, caller, method, b).await? {
        ControlFlow::Break(v) => Ok(v),
        ControlFlow::Continue(_) => Err(UnknownMethod.into()),
    }
}

/// A call from an invited person: the device check, then the allow-list and the chat checks, every one audited, then
/// the method itself with its answer shaped for them.
async fn member_call(
    hub: &Arc<Hub>,
    caller: &Caller,
    person: &str,
    proven: bool,
    method: &str,
    b: Value,
    permitted: Result<(), Forbidden>,
) -> Result<Value> {
    let verdict = match permitted {
        Ok(()) => roles::guard(hub, person, proven, method, &b).await,
        Err(e) => Err(e.into()),
    };
    let target = roles::target_of(&b);
    let outcome = match verdict {
        Ok(()) => route(hub, caller, method, b).await,
        Err(e) => Err(e),
    };
    // A refused call is logged as denied. The proof call is allowed to every unproven device but only counts when it checks out.
    let allowed = outcome.is_ok()
        || (method != "proveInvite" && !matches!(&outcome, Err(e) if e.is::<NotAllowed>() || e.is::<Forbidden>()));
    hub.store.audit_add(person, caller.device_key(), method, target.as_deref(), allowed);
    let mut shaped = roles::shape(hub, person, method, outcome?);
    if method == "hello" && shaped.is_object() {
        shaped["grantedAgents"] = roles::granted_agents(hub, person).await.into();
    }
    Ok(shaped)
}
