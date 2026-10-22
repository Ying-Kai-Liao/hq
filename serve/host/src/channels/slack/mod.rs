//! Slack: one app in Socket Mode (no public URL), a `slack/<workspace>` profile granted to the client `serve` with
//! `SLACK_BOT_TOKEN` (xoxb-) and `SLACK_APP_TOKEN` (xapp-, connections:write), ported from
//! `kernel/lib/hq_bridge/slack_chat.py`. Channels the app is in and DMs with it are rooms; a task is a Slack thread.
//! `@agent` as plain text picks the agent (Slack has one bot user per app, so no autocomplete); mentioning the app
//! or a DM addresses hq; commands start with `!` (Slack keeps `/` for its own): `!link CODE`, `!agents`, `!default`,
//! `!stop`, `!whoami`. Agents post under their display name (chat:write.customize).
//!
//! The app needs: bot scopes `app_mentions:read`, `channels:history`, `groups:history`, `im:history`,
//! `chat:write`, `chat:write.customize`, `files:read`, `files:write`, `reactions:write`; events `message.channels`,
//! `message.groups`, `message.im`, `app_mention`; Interactivity on (the Stop and pick buttons); Socket Mode on.
//!
//! Slack resends an event that isn't acknowledged within three seconds, so every envelope is acknowledged the moment
//! it arrives and handled after, one message at a time, off the socket's reading loop (which must keep answering
//! pings). A message Slack delivers twice (a retry, or the same one as `message` and `app_mention`) is handled once.
//!
//! Both tokens are secrets and Socket Mode's URL carries a ticket: nothing here logs a URL or an unscrubbed error.
//! The Web API is `https://slack.com/api`, or `KITH_SLACK_API` (tests); the socket's address is whatever
//! `apps.connections.open` answers with.

mod api;
mod inbound;
mod outbound;
mod text;

#[cfg(test)]
mod tests;

use super::adapter::{Adapter, Alive, Constructor, Secrets};
use super::core::Core;
use crate::LockExt;
use anyhow::{Context as _, Result, anyhow, bail};
use api::{Api, As, SlackError};
use futures::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_API: &str = "https://slack.com/api";
const FOOTER: &str = "\n\n(From Slack: this thread is your task. Your final answer is posted here automatically; Markdown works. send images and files with kith-send; files the user sent are listed as paths. Helpers you call post status with `kith-send --as <their name>`.)";
const STOP_REACTION: &str = "octagonal_sign";
const REDO_REACTION: &str = "repeat";
/// How much of an answer goes into one markdown block (Slack holds 12,000).
const CHUNK: usize = 11_000;
/// The plain `text` that goes with the blocks (notifications, search) is cut here.
const PLAIN: usize = 3000;
/// How many message ids are remembered to catch a delivery repeated.
const SEEN: usize = 2000;

/// How long to wait, and how much to take.
#[derive(Clone, Copy, Debug)]
pub struct Pace {
    /// A ping on the socket this often; Slack's pong (or anything else it sends) is the sign of life.
    pub ping: Duration,
    /// Between a `disconnect` envelope and the new socket.
    pub reconnect: Duration,
    /// Files above this many bytes are not downloaded.
    pub max_file: u64,
    /// How long a button press may take in the core.
    pub press: Duration,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            ping: Duration::from_secs(20),
            reconnect: Duration::from_millis(500),
            max_file: 25 * 1024 * 1024,
            press: Duration::from_secs(60),
        }
    }
}

/// Messages already taken, newest last.
#[derive(Default)]
struct Seen {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl Seen {
    /// True the first time.
    fn first(&mut self, key: String) -> bool {
        if !self.set.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > SEEN
            && let Some(old) = self.order.pop_front()
        {
            self.set.remove(&old);
        }
        true
    }
}

pub struct Slack {
    conn: String,
    api: Api,
    core: Arc<Core>,
    alive: Alive,
    /// The app's bot user id, known after auth.test.
    me: Mutex<String>,
    seen: Mutex<Seen>,
    /// The queue of the one task that handles messages, started on the first run and kept across sockets and
    /// restarts of `run`, so two messages are never handled at once.
    queue: OnceLock<mpsc::UnboundedSender<Work>>,
    pub pace: Pace,
    /// The socket is pinged every `pace.ping`, so a healthy one is never silent for longer.
    pub quiet: Duration,
}

/// The adapter of the `slack` platform, for [`super::Registry`].
pub fn constructor() -> Constructor {
    Arc::new(|conn, secrets: Secrets, core| {
        let bot = secrets.get("SLACK_BOT_TOKEN").ok_or_else(|| anyhow!("SLACK_BOT_TOKEN is not set"))?;
        let app = secrets.get("SLACK_APP_TOKEN").ok_or_else(|| anyhow!("SLACK_APP_TOKEN is not set"))?;
        let base = std::env::var("KITH_SLACK_API").ok().filter(|b| !b.is_empty());
        Ok(Arc::new(Slack::new(conn, bot, app, base.as_deref().unwrap_or(DEFAULT_API), core)) as Arc<dyn Adapter>)
    })
}

/// What the supervisor's reader hands the handler.
enum Work {
    Event(Value),
}

impl Slack {
    pub fn new(conn: &str, bot: &str, app: &str, base: &str, core: Arc<Core>) -> Self {
        Self {
            conn: conn.to_owned(),
            api: Api::new(base, bot, app),
            core,
            alive: Alive::default(),
            me: Mutex::new(String::new()),
            seen: Mutex::new(Seen::default()),
            queue: OnceLock::new(),
            pace: Pace::default(),
            quiet: Duration::from_secs(120),
        }
    }

    fn me(&self) -> String {
        self.me.locked().clone()
    }

    /// A bot call whose failure only matters to the caller.
    async fn sl(&self, method: &str, params: Value) -> Result<Value, SlackError> {
        self.api.call_retry(method, &params).await
    }

    /// A cosmetic call: a message that is gone or unchanged is not an error.
    async fn quietly(&self, method: &str, params: Value) {
        if let Err(e) = self.sl(method, params).await {
            tracing::debug!("{}: {method} failed: {e}", self.conn);
        }
    }

    fn small(text: &str) -> Value {
        json!({"type": "context", "elements": [{"type": "mrkdwn", "text": text}]})
    }

    fn stop_button(wid: &str) -> Value {
        json!({"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Stop"},
                                                 "action_id": "kith-stop", "value": wid}]})
    }

    // ---- the connection ----

    async fn run(self: &Arc<Self>) -> Result<()> {
        let who = self.api.call("auth.test", &json!({}), As::Bot).await?;
        who["user_id"].as_str().unwrap_or("").clone_into(&mut self.me.locked());
        tracing::info!("{}: in {} as {}", self.conn, who["team"].as_str().unwrap_or(""), self.me());
        let this: Arc<dyn Adapter> = self.clone();
        let tx = self.queue.get_or_init(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<Work>();
            // One message at a time, in order, but off the socket: the reader must keep answering pings. The task
            // belongs to the adapter, not to a socket: when the socket is replaced it finishes the messages already
            // acknowledged (Slack won't send them again). It holds the adapter weakly and ends with it.
            let weak = Arc::downgrade(self);
            tokio::spawn(async move {
                while let Some(Work::Event(e)) = rx.recv().await {
                    let Some(me) = weak.upgrade() else { break };
                    let this: Arc<dyn Adapter> = me.clone();
                    // One bad message must not stop the app.
                    if let Err(e) = me.message(&this, &e).await {
                        tracing::warn!("{}: message failed: {e:#}", me.conn);
                    }
                }
            });
            tx
        });
        let mut resumed = false;
        loop {
            self.session(&this, tx, &mut resumed).await?;
            // Slack asked for a new socket (they are replaced every few hours), or this one closed.
            tokio::time::sleep(self.pace.reconnect).await;
        }
    }

    /// How long one message may take: well under `quiet`.
    fn handle_limit(&self) -> Duration {
        self.quiet.saturating_sub(Duration::from_secs(30)).max(self.quiet / 2)
    }

    /// One socket: returns Ok when Slack asks for another, an error when it breaks.
    async fn session(
        self: &Arc<Self>,
        this: &Arc<dyn Adapter>,
        tx: &mpsc::UnboundedSender<Work>,
        resumed: &mut bool,
    ) -> Result<()> {
        let open = self.api.call("apps.connections.open", &json!({}), As::App).await?;
        let url = open["url"].as_str().context("Slack gave no socket address")?.to_owned();
        let connecting = tokio::time::timeout(Duration::from_secs(30), tokio_tungstenite::connect_async(url.as_str()));
        let (ws, _) = connecting
            .await
            .map_err(|_| anyhow!("timed out connecting to Slack's socket"))?
            .map_err(|e| anyhow!("{}", self.api.scrub(&e.to_string()).replace(&url, "<socket>")))?;
        self.alive.touch();
        let (mut sink, mut stream) = ws.split();
        if !*resumed {
            *resumed = true;
            self.core.resume(this);
        }
        // A socket that closes or breaks is replaced like one Slack retires: only failing to open one ends `run`.
        if let Err(e) = self.pump(this, tx, &mut sink, &mut stream).await {
            tracing::info!("{}: socket lost, opening another: {e:#}", self.conn);
        }
        Ok(())
    }

    /// Reads one socket until it ends: Ok on a `disconnect` envelope, an error when it closes or breaks.
    async fn pump<S, R>(
        self: &Arc<Self>,
        this: &Arc<dyn Adapter>,
        tx: &mpsc::UnboundedSender<Work>,
        sink: &mut S,
        stream: &mut R,
    ) -> Result<()>
    where
        S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
        R: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        let mut ping = tokio::time::interval(self.pace.ping);
        ping.reset();
        loop {
            tokio::select! {
                msg = stream.next() => {
                    self.alive.touch();
                    match msg {
                        None => bail!("Slack's socket closed"),
                        Some(Err(e)) => bail!("Slack's socket: {}", self.api.scrub(&e.to_string())),
                        Some(Ok(Message::Close(_))) => bail!("Slack closed the socket"),
                        Some(Ok(Message::Ping(p))) => sink.send(Message::Pong(p)).await?,
                        Some(Ok(Message::Text(t))) => {
                            let Ok(envelope) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                            if envelope["type"] == "disconnect" {
                                tracing::info!("{}: Slack asked for a new socket ({})", self.conn, envelope["reason"].as_str().unwrap_or(""));
                                return Ok(());
                            }
                            // Acknowledged first: Slack resends what it has no answer to within three seconds.
                            if let Some(id) = envelope["envelope_id"].as_str() {
                                sink.send(Message::Text(json!({"envelope_id": id}).to_string().into())).await?;
                            }
                            self.dispatch(this, tx, &envelope);
                        }
                        Some(Ok(_)) => {}
                    }
                }
                _ = ping.tick() => sink.send(Message::Ping(Vec::new().into())).await?,
            }
        }
    }

    fn dispatch(self: &Arc<Self>, this: &Arc<dyn Adapter>, tx: &mpsc::UnboundedSender<Work>, envelope: &Value) {
        let payload = &envelope["payload"];
        match envelope["type"].as_str() {
            Some("events_api") => {
                let event = &payload["event"];
                if matches!(event["type"].as_str(), Some("message" | "app_mention")) {
                    let _ = tx.send(Work::Event(event.clone()));
                }
            }
            Some("interactive") if payload["type"] == "block_actions" => {
                // Not queued behind messages: a Stop press matters most while a message is being handled.
                let (me, this, payload) = (self.clone(), this.clone(), payload.clone());
                tokio::spawn(async move {
                    if tokio::time::timeout(me.pace.press, me.button(&this, &payload)).await.is_err() {
                        tracing::warn!("{}: a button press took too long", me.conn);
                    }
                });
            }
            _ => {}
        }
    }
}
