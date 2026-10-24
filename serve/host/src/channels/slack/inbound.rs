//! Messages and button presses in.

use super::api::SlackError;
use super::{Slack, text};
use crate::LockExt;
use crate::channels::adapter::{Adapter, Incoming, StopPress};
use anyhow::Result;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

impl Slack {
    /// One `message` or `app_mention` event -> the core, unless it is none of hq's business.
    pub(super) async fn message(self: &Arc<Self>, this: &Arc<dyn Adapter>, e: &Value) -> Result<()> {
        let Some(mut m) = self.incoming(e) else { return Ok(()) };
        let (channel, ts) = (e["channel"].as_str().unwrap_or(""), e["ts"].as_str().unwrap_or(""));
        // Slack sends a message mentioning the app twice (message and app_mention) and again if it wasn't
        // acknowledged: the first one counts.
        if !self.seen.locked().first(format!("{channel}:{ts}")) {
            return Ok(());
        }
        let has_files = e["files"].as_array().is_some_and(|f| !f.is_empty());
        let (files, notes) = if has_files && self.core.knows_sender("slack", &m.uid, false).await {
            self.download(e).await
        } else {
            (Vec::new(), Vec::new()) // a stranger's files are not fetched
        };
        m.files = files;
        m.text = notes.iter().fold(m.text, |t, n| if t.is_empty() { n.clone() } else { format!("{t}\n\n{n}") });
        // A stuck core (a hanging hq-auth) must end well before the supervisor decides the connection is dead.
        tokio::time::timeout(self.handle_limit(), self.core.handle(this, &m))
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("took too long")))
    }

    /// The event as the core's message (without its files), or None for bots, edits, joins and chatter in a room
    /// that wasn't meant for hq.
    pub(super) fn incoming(&self, e: &Value) -> Option<Incoming> {
        let me = self.me();
        let user = e["user"].as_str().filter(|u| !u.is_empty())?;
        let subtype = e["subtype"].as_str();
        if e["bot_id"].as_str().is_some_and(|b| !b.is_empty())
            || !matches!(subtype, None | Some("file_share" | "thread_broadcast"))
            || user == me
            || !e["edited"].is_null()
        {
            return None; // bots (hq's own posts too), edits, joins
        }
        let (channel, ts) = (e["channel"].as_str()?, e["ts"].as_str()?);
        let private = e["channel_type"] == "im";
        let raw = e["text"].as_str().unwrap_or("");
        let addressed = private || e["type"] == "app_mention" || raw.contains(&format!("<@{me}>"));
        let text = text::clean(raw, &me);
        let room = format!("{}:{channel}", self.conn);
        let thread = e["thread_ts"].as_str().map(|t| format!("{}:{channel}:{t}", self.conn));
        let mine = thread.as_deref().is_some_and(|t| self.core.has_thread(t));
        let default = self.core.room_default(&room).is_some_and(|d| !d.is_empty());
        if !(private || addressed || mine || text::has_agent_word(&text) || default) {
            return None;
        }
        // A message forwarded into this one is context for the agent.
        let quoted = e["attachments"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["is_share"] == true || a["is_msg_unfurl"] == true)
            .find_map(|a| a["text"].as_str().filter(|t| !t.is_empty()))
            .unwrap_or("")
            .to_owned();
        Some(Incoming {
            uid: user.to_owned(),
            text,
            room,
            origin: json!({"channel": channel, "ts": ts, "thread_ts": e["thread_ts"]}),
            thread,
            private,
            addressed,
            quoted,
            reference: json!({"channel": channel, "ts": ts}),
            sent: text::sent(ts),
            ..Incoming::default()
        })
    }

    /// The files of a message, saved under the connection's attachments folder (`<channel>/<ts>`) -> their paths.
    /// Files over the size limit are not fetched: the agent is told instead (second value).
    async fn download(&self, e: &Value) -> (Vec<String>, Vec<String>) {
        let (mut got, mut notes) = (Vec::new(), Vec::new());
        for (index, f) in e["files"].as_array().into_iter().flatten().enumerate() {
            let Some(url) = f["url_private_download"].as_str().or_else(|| f["url_private"].as_str()) else { continue };
            // The sender chooses the name: only its last part counts.
            let named = f["name"].as_str().or_else(|| f["id"].as_str()).unwrap_or("file");
            let name = Path::new(named).file_name().map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
            if f["size"].as_u64().is_some_and(|n| n > self.pace.max_file) {
                notes.push(format!("(file too big: {name})"));
                continue;
            }
            let folder = self
                .core
                .attachments_dir(&self.conn)
                .join(e["channel"].as_str().unwrap_or("").replace('/', "_"))
                .join(e["ts"].as_str().unwrap_or("").replace('/', "_"));
            // Two files of one message may share a name: the file id (or position) keeps them apart.
            let tag = f["id"].as_str().filter(|i| !i.is_empty()).map_or_else(|| index.to_string(), str::to_owned);
            let dest = folder.join(format!("{}-{}", tag.replace('/', "_"), name));
            let saved = async {
                tokio::fs::create_dir_all(&folder).await.map_err(|e| SlackError::Net(e.to_string()))?;
                self.api.download(url, &dest, self.pace.max_file).await
            };
            match saved.await {
                Ok(()) => got.push(dest.to_string_lossy().into_owned()),
                Err(e) if e.to_string().contains("file too big") => notes.push(format!("(file too big: {name})")),
                Err(e) => {
                    tracing::warn!("{}: file not downloaded: {e}", self.conn);
                    notes.push(format!("(file not downloaded: {name})"));
                }
            }
        }
        (got, notes)
    }

    /// A press on the Stop or a pick button.
    pub(super) async fn button(self: &Arc<Self>, this: &Arc<dyn Adapter>, p: &Value) {
        let act = &p["actions"][0];
        let uid = p["user"]["id"].as_str().unwrap_or("");
        let channel = p["channel"]["id"].as_str().or_else(|| p["container"]["channel_id"].as_str()).unwrap_or("");
        let ts = &p["container"]["message_ts"];
        let (id, value) = (act["action_id"].as_str().unwrap_or(""), act["value"].as_str().unwrap_or(""));
        let tell = |text: &str| json!({"channel": channel, "user": uid, "text": text});
        let edit = |text: &str| json!({"channel": channel, "ts": ts, "text": text, "blocks": [Self::small(text)]});
        if id == "kith-stop" || id == "hq-stop" {
            match self.core.stop_pressed(this, value, uid).await {
                StopPress::NotYours => {
                    self.quietly("chat.postEphemeral", tell("Only the person who started this can stop it.")).await;
                }
                StopPress::Stopping => {
                    let stopped = self.stopped_lines.lock().await;
                    if !stopped.contains(&format!("{channel}:{}", ts.as_str().unwrap_or(""))) {
                        self.quietly("chat.update", edit("stopping…")).await;
                    }
                }
                StopPress::Finished => {}
            }
        } else if id.starts_with("kith-pick") || id.starts_with("hq-pick") {
            let Some((pid, agent)) = value.split_once(':') else { return };
            match self.core.picked(this, pid, agent, uid).await {
                Ok(true) => self.quietly("chat.update", edit(&format!("→ {agent}"))).await,
                Ok(false) => self.quietly("chat.postEphemeral", tell("That question is someone else's.")).await,
                Err(e) => tracing::warn!("{}: pick failed: {e:#}", self.conn),
            }
        }
    }
}
