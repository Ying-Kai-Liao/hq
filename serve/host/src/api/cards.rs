//! The API the kernel calls for approval cards. A run that the kernel starts itself (`kith ask`, `kith-sched`) is
//! outside the host's own launch path, so before it starts `claude` it asks the host, with its owner credentials (the
//! serve token), for a token that can do one thing: `requestPermission` on the run socket.
//!
//! `issueAskToken {agent, session, pid}` -> `{token, socket, env, expiresInS}`
//!   - `agent`: the hq agent the run is for. `session`: what the run continues (a card is per session and resource, and a
//!     once grant is only good in its own session). `pid`: the process the run will be started under (usually the
//!     kernel's own pid): the socket only accepts the token from that process or one of its children.
//!   - Give the run `env` (`KITH_ASK_TOKEN`, `KITH_ASK_SOCKET`) so the `--permission-prompt-tool` server it starts can
//!     call the socket. The token ends after `expiresInS`, when the process is gone, or on `revokeAskToken {token}`.
//!
//! Owner credentials only, and only from this computer: members, bot guests and paired phones never reach it.

use super::str_arg;
use crate::hub::Hub;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::ops::ControlFlow;
use std::sync::Arc;

#[allow(clippy::unused_async, reason = "one of the method groups `route` awaits in turn")]
pub(super) async fn call(_hub: &Arc<Hub>, method: &str, b: Value) -> Result<ControlFlow<Value, Value>> {
    Ok(ControlFlow::Break(match method {
        "issueAskToken" => {
            let (agent, session) = (str_arg(&b, "agent")?, str_arg(&b, "session")?);
            let Some(pid) = b["pid"].as_u64().and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 1) else {
                bail!("`pid` is required");
            };
            if agent.is_empty() || agent.len() > 128 || session.is_empty() || session.len() > 256 {
                bail!("`agent` and `session` must be short, non-empty words");
            }
            let Some(socket) = crate::runauth::socket() else { bail!("the run socket isn't listening") };
            let ttl = crate::runauth::ASK_TOKEN_TTL;
            let token = crate::runauth::table().insert_ask(crate::runauth::ask_identity(agent, session), pid, ttl)?;
            json!({
                "token": token,
                "socket": socket,
                "env": {
                    crate::runauth::ASK_TOKEN_ENV: token,
                    crate::runauth::ASK_SOCKET_ENV: socket,
                },
                "expiresInS": ttl.as_secs(),
            })
        }
        "revokeAskToken" => json!({"revoked": crate::runauth::table().revoke_token(str_arg(&b, "token")?)}),
        _ => return Ok(ControlFlow::Continue(b)),
    }))
}
