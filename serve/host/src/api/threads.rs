//! Threads of terminal sessions: the kernel resolves a thread to its Claude session (`kith <agent> --resume`), and
//! the apps take a thread over from the terminal that holds it. Owner only (not on the member list).

use super::str_arg;
use crate::hub::Hub;
use anyhow::Result;
use serde_json::Value;
use std::ops::ControlFlow;
use std::sync::Arc;

pub(super) async fn call(hub: &Arc<Hub>, method: &str, b: Value) -> Result<ControlFlow<Value, Value>> {
    Ok(ControlFlow::Break(match method {
        // `{botId, threadId, agent, sessionId, cwd, hostBusy}` for a thread id or a session id.
        "resolveThread" => crate::terminal::resolve(hub, str_arg(&b, "thread")?).await,
        // Ends the terminal that holds the thread; refused while it works, a no-op once it is closed.
        "takeOverThread" => crate::terminal::take_over(hub, str_arg(&b, "botId")?, str_arg(&b, "threadId")?).await?,
        _ => return Ok(ControlFlow::Continue(b)),
    }))
}
