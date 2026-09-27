//! Built-in stdio MCP servers: `team` discovers and asks other bots; `computer`
//! operates the desktop when enabled. Calls go through authenticated loopback
//! HTTP to the running host, which owns delegation and screen control.

use anyhow::Result;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Copy)]
pub enum Server {
    Routines,
    Computer,
    Team,
    Composio,
}

const INSTRUCTIONS: &str = "Operate this computer's desktop like a person would. Start with `screenshot` \
(or `ui_tree` to find controls precisely), then act; every action returns a fresh screenshot. \
Coordinates are pixels in the latest screenshot. Prefer keyboard shortcuts and `open_app` over hunting with the mouse. \
Don't type passwords or approve payments: ask the user to do that from their phone.";

fn tools() -> Value {
    let display = json!({"type": "integer", "description": "Display id; defaults to the main display."});
    let xy = |what: &str| json!({"type": "number", "description": format!("{what} in screenshot pixels.")});
    json!([
        {
            "name": "screenshot",
            "description": "Capture the screen. Returns a JPEG whose pixels are the coordinate space for every other tool.",
            "inputSchema": {"type": "object", "properties": {"display": display}},
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "ui_tree",
            "description": "Accessibility tree of the frontmost app: roles, titles, values and frames in screenshot pixels. Cheaper and more precise than reading pixels when you need to find a control.",
            "inputSchema": {"type": "object", "properties": {"display": display}},
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "click",
            "description": "Click at a point. Returns a screenshot afterwards.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": xy("X"), "y": xy("Y"),
                    "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
                    "count": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1, "description": "2 = double-click, 3 = triple-click."},
                    "modifiers": {"type": "array", "items": {"type": "string", "enum": ["cmd", "option", "ctrl", "shift"]}, "description": "Keys held during the click."},
                    "display": display,
                },
                "required": ["x", "y"],
            },
        },
        {
            "name": "move",
            "description": "Move the pointer (for hover menus and tooltips). Returns a screenshot afterwards.",
            "inputSchema": {"type": "object", "properties": {"x": xy("X"), "y": xy("Y"), "display": display}, "required": ["x", "y"]},
        },
        {
            "name": "drag",
            "description": "Press at (x, y), drag to (to_x, to_y), release. Returns a screenshot afterwards.",
            "inputSchema": {
                "type": "object",
                "properties": {"x": xy("Start x"), "y": xy("Start y"), "to_x": xy("End x"), "to_y": xy("End y"), "display": display},
                "required": ["x", "y", "to_x", "to_y"],
            },
        },
        {
            "name": "scroll",
            "description": "Scroll with the pointer over (x, y). Returns a screenshot afterwards.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": xy("X"), "y": xy("Y"),
                    "dx": {"type": "number", "description": "Lines to scroll right (negative = left)."},
                    "dy": {"type": "number", "description": "Lines to scroll down (negative = up)."},
                    "display": display,
                },
                "required": ["x", "y"],
            },
        },
        {
            "name": "type",
            "description": "Type text into the focused field (any Unicode). Returns a screenshot afterwards.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        },
        {
            "name": "key",
            "description": "Press a key or shortcut, e.g. `return`, `escape`, `tab`, `cmd+t`, `cmd+shift+4`, `ctrl+c`. On Linux `cmd` is Super. Returns a screenshot afterwards.",
            "inputSchema": {"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]},
        },
        {
            "name": "open_app",
            "description": "Open or bring an application to the front by name (e.g. `Safari`, `Simulator`, `firefox`). Returns a screenshot afterwards.",
            "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
        },
    ])
}

/// Serves MCP on stdio until the agent closes it.
pub async fn serve(bot: String, port: u16, server: Server) -> Result<()> {
    let token = std::fs::read_to_string(crate::service::data_dir().join("token")).unwrap_or_default();
    let token = token.trim().to_owned();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    let (name, instructions, available_tools) = match server {
        Server::Computer => ("codync-computer", INSTRUCTIONS, tools()),
        Server::Routines => ("codync-routines", crate::routines::INSTRUCTIONS, crate::routines::tools()),
        Server::Team => ("codync-team", crate::chat::team::INSTRUCTIONS, crate::chat::team::tools()),
        Server::Composio => {
            ("codync-composio", crate::market::composio::INSTRUCTIONS, crate::market::composio::tools())
        }
    };
    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").filter(|id| !id.is_null()).cloned() else {
            continue; // notifications (`notifications/initialized`, cancellations)
        };
        let params = &msg["params"];
        let reply = match msg["method"].as_str().unwrap_or_default() {
            "initialize" => Ok(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": name, "version": env!("CARGO_PKG_VERSION")},
                "instructions": instructions,
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": available_tools})),
            "tools/call" => Ok(call(port, &token, &bot, params, server).await),
            method => Err(json!({"code": -32601, "message": format!("unknown method {method}")})),
        };
        let msg = match reply {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        };
        let mut line = serde_json::to_vec(&msg)?;
        line.push(b'\n');
        out.write_all(&line).await?;
        out.flush().await?;
    }
    Ok(())
}

/// One tool call through the host. Failures are tool errors the agent can read, not protocol errors.
async fn call(port: u16, token: &str, bot: &str, params: &Value, server: Server) -> Value {
    let body = json!({
        "botId": bot,
        "name": params["name"],
        "arguments": params.get("arguments").filter(|a| a.is_object()).cloned().unwrap_or_else(|| json!({})),
    });
    let (method, timeout) = match server {
        Server::Routines => ("routineCall", Duration::from_secs(30)),
        Server::Computer => ("computerCall", Duration::from_secs(60)),
        Server::Team => ("teamCall", crate::chat::team::ASK_TIMEOUT + Duration::from_secs(30)),
        Server::Composio => ("composioCall", Duration::from_secs(120)),
    };
    let res = crate::http()
        .post(format!("http://127.0.0.1:{port}/api/{method}"))
        .bearer_auth(token)
        .json(&body)
        .timeout(timeout)
        .send()
        .await;
    let error = match res {
        Ok(r) => {
            let ok = r.status().is_success();
            match r.json::<Value>().await {
                Ok(v) if ok => {
                    return match server {
                        Server::Computer => json!({"content": v["content"]}),
                        Server::Team | Server::Routines => {
                            json!({"content": [{"type": "text", "text": v.to_string()}]})
                        }
                        Server::Composio => json!({"content": [{"type": "text", "text": v["result"].to_string()}]}),
                    };
                }
                Ok(v) => v["error"].as_str().unwrap_or("the Codync host refused the call").to_owned(),
                Err(e) => format!("bad response from the Codync host: {e}"),
            }
        }
        Err(e) => format!("can't reach the Codync host: {e}"),
    };
    json!({"content": [{"type": "text", "text": error}], "isError": true})
}

/// `codync-host mcp remote`: a stdio MCP server that forwards every message to a remote
/// (streamable HTTP) connector with the headers and fresh sign-in token the host gives it.
pub async fn serve_remote(connector: String, port: u16) -> Result<()> {
    let token = std::fs::read_to_string(crate::service::data_dir().join("token")).unwrap_or_default();
    let token = token.trim().to_owned();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    let mut session: Option<String> = None;
    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let replies = match forward(port, &token, &connector, &msg, &mut session).await {
            Ok(replies) => replies,
            // Only requests get an answer; a failed notification is dropped.
            Err(e) => match msg.get("id").filter(|id| !id.is_null()) {
                Some(id) => {
                    vec![json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": format!("{e:#}")}})]
                }
                None => vec![],
            },
        };
        for reply in replies {
            let mut line = serde_json::to_vec(&reply)?;
            line.push(b'\n');
            out.write_all(&line).await?;
        }
        out.flush().await?;
    }
    Ok(())
}

/// Sends one message; returns what the server answered (JSON, or the events of an SSE stream).
async fn forward(
    port: u16,
    token: &str,
    connector: &str,
    msg: &Value,
    session: &mut Option<String>,
) -> Result<Vec<Value>> {
    use futures::StreamExt as _;
    for stale in [false, true] {
        let target = crate::http()
            .post(format!("http://127.0.0.1:{port}/api/connectorTarget"))
            .bearer_auth(token)
            .json(&json!({"id": connector, "stale": stale}))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("can't reach the Codync host: {e}"))?;
        let ok = target.status().is_success();
        let target: Value = target.json().await?;
        if !ok {
            anyhow::bail!("{}", target["error"].as_str().unwrap_or("the Codync host refused"));
        }
        let url = target["url"].as_str().unwrap_or_default();
        let mut req = crate::http()
            .post(url)
            .header("accept", "application/json, text/event-stream")
            .json(msg)
            .timeout(Duration::from_secs(600));
        for (k, v) in target["headers"].as_object().into_iter().flatten() {
            req = req.header(k.as_str(), v.as_str().unwrap_or_default());
        }
        if let Some(s) = session.as_deref() {
            req = req.header("mcp-session-id", s);
        }
        let res = req.send().await.map_err(|e| anyhow::anyhow!("can't reach {url}: {e}"))?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED && !stale {
            continue;
        }
        if res.status() == reqwest::StatusCode::NOT_FOUND && session.is_some() && !stale {
            // The server forgot our session; start over without it.
            *session = None;
            continue;
        }
        if let Some(s) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session = Some(s.to_owned());
        }
        if !res.status().is_success() {
            anyhow::bail!("{url} answered {}", res.status());
        }
        let sse = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("text/event-stream"));
        if !sse {
            let body = res.bytes().await?;
            if body.is_empty() {
                return Ok(vec![]);
            }
            return Ok(match serde_json::from_slice::<Value>(&body)? {
                Value::Array(all) => all,
                one => vec![one],
            });
        }
        // Read events until the answer to this request arrives (servers may keep the stream open).
        let id = msg.get("id").filter(|id| !id.is_null());
        let mut got = vec![];
        let mut buf = String::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            buf.push_str(&String::from_utf8_lossy(&chunk?).replace("\r\n", "\n"));
            while let Some(end) = buf.find("\n\n") {
                let event: String = buf.drain(..end + 2).collect();
                if let Some(v) = sse_data(&event) {
                    let done = id.is_some_and(|id| v.get("id") == Some(id) && v.get("method").is_none());
                    got.push(v);
                    if done {
                        return Ok(got);
                    }
                }
            }
        }
        return Ok(got);
    }
    anyhow::bail!("{connector} still refuses the sign-in; sign in again in Marketplace")
}

/// The JSON in one SSE event's `data:` lines.
fn sse_data(event: &str) -> Option<Value> {
    let data: Vec<&str> =
        event.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.strip_prefix(' ').unwrap_or(d)).collect();
    serde_json::from_str(&data.join("\n")).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sse_events() {
        assert_eq!(sse_data("event: message\ndata: {\"id\":1}\n\n").unwrap()["id"], 1);
        assert_eq!(sse_data("data:{\"a\":\ndata: 2}\n\n").unwrap()["a"], 2);
        assert!(sse_data(": ping\n\n").is_none());
    }

    #[test]
    fn every_tool_parses_as_a_computer_tool() {
        for t in tools().as_array().unwrap() {
            let name = t["name"].as_str().unwrap();
            let required = t["inputSchema"]["required"].as_array().cloned().unwrap_or_default();
            let mut args = json!({});
            for r in required {
                let k = r.as_str().unwrap();
                args[k] = if t["inputSchema"]["properties"][k]["type"] == "string" { json!("x") } else { json!(1) };
            }
            let parsed =
                serde_json::from_value::<crate::screen::ComputerTool>(json!({"name": name, "arguments": args}));
            assert!(parsed.is_ok(), "{name}: {parsed:?}");
        }
    }
}
