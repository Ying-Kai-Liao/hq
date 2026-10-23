//! Calls between an agent and its person: the agent's `callPerson` (loopback only, from `kith-call`), and the
//! person's answers from their apps.

use super::devices::{Caller, Principal, principal};
use super::str_arg;
use crate::hub::Hub;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::ops::ControlFlow;
use std::sync::Arc;

pub(super) async fn call(hub: &Arc<Hub>, caller: &Caller, method: &str, b: Value) -> Result<ControlFlow<Value, Value>> {
    Ok(ControlFlow::Break(match method {
        // `kith-call`: the run says its agent (and the invited person it works for, if any), the host finds the chat.
        // Only that person's own chat can be rung, so a run never reaches anyone else.
        "callPerson" => {
            let (agent, reason) = (str_arg(&b, "agent")?, str_arg(&b, "reason")?);
            let person = b["person"].as_str().filter(|p| !p.is_empty());
            let Some(chat) = crate::calls::chat_of(hub, agent, person) else {
                return Ok(ControlFlow::Break(json!({"status": "not-allowed"})));
            };
            crate::calls::ring_and_wait(hub, &chat, None, reason, b["wait"] == true).await?
        }
        "callAccept" | "callDecline" | "callGreet" => {
            let who = match principal(&hub.store, caller) {
                Principal::Owner => None,
                Principal::Member(person) => Some(person),
                Principal::Nobody | Principal::Unproven(_) => bail!("this device isn't allowed on this computer"),
            };
            let id = str_arg(&b, "id")?;
            match method {
                "callAccept" => crate::calls::accept(hub, who.as_deref(), id)?,
                "callDecline" => crate::calls::decline(hub, who.as_deref(), id)?,
                _ => crate::calls::greet(hub, who.as_deref(), id)?,
            }
        }
        _ => return Ok(ControlFlow::Continue(b)),
    }))
}
