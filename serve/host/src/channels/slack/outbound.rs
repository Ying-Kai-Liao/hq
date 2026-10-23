//! What hq says on Slack: the [`Adapter`] side.

use super::api::SlackError;
use super::{CHUNK, FOOTER, PLAIN, REDO_REACTION, STOP_REACTION, Slack};
use crate::channels::adapter::{Adapter, Alive, Ended, Fut, Incoming, Reaction};
use crate::channels::core::Core;
use crate::channels::text::first_chars;
use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const MB: u64 = 1024 * 1024;
/// Files above this are not uploaded (read whole into memory first).
pub(super) const MAX_UPLOAD: u64 = 100 * MB;

#[derive(Debug)]
struct TooBig(String);

impl std::fmt::Display for TooBig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TooBig {}

/// The thread a note or a question goes to: the message's own, or one started on it. A direct message outside any
/// thread gets its notes outside one too.
fn thread_of(m: &Incoming, always: bool) -> Value {
    let o = &m.origin;
    if !o["thread_ts"].is_null() {
        o["thread_ts"].clone()
    } else if m.private && !always {
        Value::Null
    } else {
        o["ts"].clone()
    }
}

impl Slack {
    /// A message into a thread under an agent's name -> Slack's answer.
    async fn say(&self, conv: &Value, agent: &str, text: &str, blocks: Option<Value>) -> Result<Value, SlackError> {
        let mut params = json!({"channel": conv["channel"], "thread_ts": conv["thread_ts"], "text": text,
                                "username": self.core.display_name(agent)});
        if let Some(blocks) = blocks {
            params["blocks"] = blocks;
        }
        self.sl("chat.postMessage", params).await
    }

    /// One file to Slack's upload URL -> its id.
    async fn upload(&self, path: &str, name: &str) -> Result<String> {
        let size = tokio::fs::metadata(path).await.context("can't read the file")?.len();
        if size > MAX_UPLOAD {
            return Err(TooBig(format!(
                "{name} is too big to send ({} MB; the limit is {} MB)",
                size / MB,
                MAX_UPLOAD / MB
            ))
            .into());
        }
        let data = tokio::fs::read(path).await.context("can't read the file")?;
        let fields = [("filename", name.to_owned()), ("length", data.len().to_string())];
        let got = self.api.form_retry("files.getUploadURLExternal", &fields).await?;
        let (Some(url), Some(id)) = (got["upload_url"].as_str(), got["file_id"].as_str()) else {
            bail!("Slack gave no upload address")
        };
        self.api.put(url, data).await?;
        Ok(id.to_owned())
    }
}

impl Adapter for Slack {
    fn platform(&self) -> &'static str {
        "slack"
    }

    fn conn(&self) -> &str {
        &self.conn
    }

    fn footer(&self) -> &'static str {
        FOOTER
    }

    fn quiet(&self) -> Option<Duration> {
        Some(self.quiet)
    }

    fn alive(&self) -> &Alive {
        &self.alive
    }

    fn start(self: Arc<Self>) -> Fut<'static, Result<()>> {
        Box::pin(async move { self.run().await })
    }

    fn reply<'a>(&'a self, m: &'a Incoming, text: &'a str) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            let mut params = json!({"channel": m.origin["channel"], "text": text});
            let thread = thread_of(m, false);
            if !thread.is_null() {
                params["thread_ts"] = thread;
            }
            self.sl("chat.postMessage", params).await?;
            Ok(())
        })
    }

    fn open_thread<'a>(
        &'a self,
        m: &'a Incoming,
        _agent: &'a str,
        _title: &'a str,
    ) -> Fut<'a, Result<(String, Value)>> {
        Box::pin(async move {
            let root = thread_of(m, true);
            let channel = m.origin["channel"].as_str().unwrap_or("");
            let key = format!("{}:{channel}:{}", self.conn, root.as_str().unwrap_or(""));
            Ok((key, json!({"channel": channel, "thread_ts": root})))
        })
    }

    fn post<'a>(&'a self, conv: &'a Value, agent: &'a str, text: &'a str, ctx_pct: Option<f64>) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            let text = ctx_pct.map_or_else(|| text.to_owned(), |ctx| format!("{text}\n\n_context {ctx:.0}%_"));
            for part in Core::chunks(&text, CHUNK) {
                let blocks = json!([{"type": "markdown", "text": part}]);
                if self.say(conv, agent, first_chars(&part, PLAIN), Some(blocks)).await.is_err() {
                    // A workspace without markdown blocks: plain text.
                    self.say(conv, agent, &part, None).await?;
                }
            }
            Ok(())
        })
    }

    fn send_files<'a>(
        &'a self,
        conv: &'a Value,
        agent: &'a str,
        files: &'a [String],
        caption: &'a str,
    ) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            // Slack's external upload: ask for a URL per file, send the bytes there, then share them all at once.
            let (mut ready, mut refused) = (Vec::new(), Vec::new());
            for f in files.iter().filter(|f| Path::new(f).is_file()) {
                let name = Path::new(f).file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                match self.upload(f, &name).await {
                    Ok(id) => ready.push(json!({"id": id, "title": name})),
                    Err(e) if e.is::<TooBig>() => refused.push(format!("{e}")),
                    Err(e) => tracing::warn!("{}: file not sent: {e:#}", self.conn),
                }
            }
            let told = |refused: Vec<String>| {
                if refused.is_empty() { Ok(()) } else { Err(anyhow::anyhow!(refused.join("; "))) }
            };
            if ready.is_empty() {
                return told(refused);
            }
            let comment = format!("*{}* {caption}", self.core.display_name(agent));
            let fields = [
                ("files", Value::Array(ready).to_string()),
                ("channel_id", conv["channel"].as_str().unwrap_or("").to_owned()),
                ("thread_ts", conv["thread_ts"].as_str().unwrap_or("").to_owned()),
                ("initial_comment", comment.trim().to_owned()),
            ];
            if let Err(e) = self.api.form_retry("files.completeUploadExternal", &fields).await {
                tracing::warn!("{}: files not shared: {e}", self.conn);
            }
            told(refused)
        })
    }

    fn status<'a>(&'a self, conv: &'a Value, agent: &'a str, wid: &'a str) -> Fut<'a, Result<Value>> {
        Box::pin(async move {
            let blocks = json!([Self::small("working…"), Self::stop_button(wid)]);
            match self.say(conv, agent, "working…", Some(blocks)).await {
                Ok(sent) => Ok(json!({"channel": sent["channel"], "ts": sent["ts"], "wid": wid})),
                Err(e) => {
                    tracing::warn!("{}: working line not shown: {e}", self.conn);
                    Ok(Value::Null)
                }
            }
        })
    }

    fn status_text<'a>(&'a self, handle: &'a Value, text: &'a str) -> Fut<'a, ()> {
        Box::pin(async move {
            if !handle.is_object() {
                return;
            }
            let mut blocks = vec![Self::small(text)];
            if !text.contains("restarting") {
                blocks.push(Self::stop_button(handle["wid"].as_str().unwrap_or("")));
            }
            let params = json!({"channel": handle["channel"], "ts": handle["ts"], "text": text, "blocks": blocks});
            self.quietly("chat.update", params).await;
        })
    }

    fn status_end<'a>(&'a self, conv: &'a Value, agent: &'a str, handle: &'a Value, ended: Ended) -> Fut<'a, ()> {
        Box::pin(async move {
            if ended == Ended::Stopped {
                if handle.is_object() {
                    let mut stopped = self.stopped_lines.lock().await;
                    if stopped.len() > 1024 {
                        stopped.clear();
                    }
                    let (c, t) = (handle["channel"].as_str().unwrap_or(""), handle["ts"].as_str().unwrap_or(""));
                    stopped.insert(format!("{c}:{t}"));
                    let params = json!({"channel": handle["channel"], "ts": handle["ts"], "text": "stopped",
                                        "blocks": [Self::small("stopped")]});
                    self.quietly("chat.update", params).await;
                } else if let Err(e) = self.say(conv, agent, "stopped", None).await {
                    tracing::debug!("{}: stopped not said: {e}", self.conn);
                }
            } else if handle.is_object() {
                self.quietly("chat.delete", json!({"channel": handle["channel"], "ts": handle["ts"]})).await;
            }
        })
    }

    fn react<'a>(&'a self, m: &'a Incoming, what: Reaction) -> Fut<'a, ()> {
        Box::pin(async move {
            if m.reference.is_object() {
                let name = match what {
                    Reaction::Stop => STOP_REACTION,
                    Reaction::Redo => REDO_REACTION,
                };
                let r = &m.reference;
                self.quietly("reactions.add", json!({"channel": r["channel"], "timestamp": r["ts"], "name": name}))
                    .await;
            }
        })
    }

    fn ask<'a>(&'a self, m: &'a Incoming, pid: &'a str, agents: &'a [String]) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            let buttons: Vec<Value> = agents
                .iter()
                .map(|a| {
                    json!({"type": "button", "text": {"type": "plain_text", "text": a},
                           "action_id": format!("kith-pick-{a}"), "value": format!("{pid}:{a}")})
                })
                .collect();
            let question = json!({"type": "section", "text": {"type": "mrkdwn", "text": "Who should take this?"}});
            let mut blocks = vec![question];
            blocks.extend(buttons.chunks(5).map(|row| json!({"type": "actions", "elements": row})));
            let params = json!({"channel": m.origin["channel"], "thread_ts": thread_of(m, true),
                                "text": "Who should take this?", "blocks": blocks});
            self.sl("chat.postMessage", params).await?;
            Ok(())
        })
    }
}
