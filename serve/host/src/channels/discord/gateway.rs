//! The gateway: one websocket that says who is talking to the bot. Heartbeats keep it open, and a dropped one
//! is resumed (nothing is lost) or, when Discord can't resume it, started over (the caller then reads back what
//! was sent in between). Every frame is a sign of life for the supervisor.

use super::Discord;
use super::tasks::Tasks;
use anyhow::{Result, anyhow, bail};
use futures::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::time::{Instant, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::{Message, protocol::frame::coding::CloseCode};

/// Guilds, guild messages, direct messages and the content of messages.
const INTENTS: u64 = 1 | (1 << 9) | (1 << 12) | (1 << 15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// What is needed to continue a dropped connection.
struct Session {
    id: String,
    url: String,
    seq: Option<u64>,
}

/// What the gateway hands on and hears back.
pub struct Wiring {
    pub tasks: Tasks,
    /// Messages, for the one task that handles them in order.
    pub messages: UnboundedSender<Value>,
    /// A reason the connection can't go on (the server isn't found), from the setup.
    pub fatal_tx: UnboundedSender<String>,
    pub fatal_rx: UnboundedReceiver<String>,
}

/// Connects, and again after each drop that can be resumed; returns an error when it can't be (a refused token).
pub async fn run(d: Arc<Discord>, mut w: Wiring) -> Result<()> {
    let mut session: Option<Session> = None;
    loop {
        serve(&d, &mut w, &mut session).await?;
        sleep(Duration::from_millis(500)).await;
    }
}

/// `wss://host` -> `wss://host/?v=10&encoding=json`.
fn socket_url(base: &str) -> String {
    if base.contains('?') {
        return base.to_owned();
    }
    let base = base.trim_end_matches('/');
    let has_path = base.split_once("://").is_some_and(|(_, rest)| rest.contains('/'));
    format!("{base}{}?v=10&encoding=json", if has_path { "" } else { "/" })
}

fn jitter() -> f64 {
    f64::from(u16::try_from(uuid::Uuid::new_v4().as_u128() % 1000).unwrap_or(0)) / 1000.0
}

/// One connection, until it drops (Ok: connect again) or can't be used (Err).
async fn serve(d: &Arc<Discord>, w: &mut Wiring, session: &mut Option<Session>) -> Result<()> {
    let url = socket_url(session.as_ref().map_or(d.cfg.gateway_url.as_str(), |s| s.url.as_str()));
    let (ws, _) = timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| anyhow!("timed out connecting to the Discord gateway"))?
        .map_err(|e| anyhow!("can't connect to the Discord gateway: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    d.alive.touch();

    let hello = loop {
        let frame = timeout(CONNECT_TIMEOUT, stream.next())
            .await
            .map_err(|_| anyhow!("the gateway said nothing"))?
            .ok_or_else(|| anyhow!("the gateway closed at once"))??;
        if let Message::Text(t) = frame {
            break serde_json::from_str::<Value>(t.as_str())?;
        }
    };
    d.alive.touch();
    if hello["op"] != 10 {
        bail!("the gateway didn't say hello");
    }
    let every = Duration::from_millis(hello["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250).max(10));

    let opening = match session.as_ref() {
        Some(s) => json!({"op": 6, "d": {"token": d.token(), "session_id": s.id, "seq": s.seq}}),
        None => json!({"op": 2, "d": {
            "token": d.token(), "intents": INTENTS,
            "properties": {"os": std::env::consts::OS, "browser": "kith-serve", "device": "kith-serve"}}}),
    };
    sink.send(Message::Text(opening.to_string().into())).await?;

    let mut beat = interval_at(Instant::now() + every.mul_f64(jitter()), every);
    let mut acked = true;
    loop {
        tokio::select! {
            frame = stream.next() => {
                let Some(frame) = frame else { return Ok(()) }; // dropped: resume
                match frame {
                    Ok(Message::Text(t)) => {
                        d.alive.touch();
                        let Ok(f) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                        if !on_frame(d, w, session, &f, &mut sink, &mut acked).await? {
                            return Ok(());
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        let code = frame.map(|f| f.code);
                        if let Some(code) = code {
                            // 4004 refused token, 4010-4014 bad shard, version or intents: trying again won't help
                            if matches!(u16::from(code), 4004 | 4010..=4014) {
                                bail!("Discord closed the gateway with {}: check the token and the bot's intents", u16::from(code));
                            }
                            if matches!(u16::from(code), 4007 | 4009) || code == CloseCode::Restart {
                                *session = None;
                            }
                        }
                        return Ok(());
                    }
                    Ok(_) => d.alive.touch(),
                    Err(e) => {
                        tracing::debug!("{}: gateway read: {e}", d.conn);
                        return Ok(());
                    }
                }
            }
            _ = beat.tick() => {
                if !acked {
                    tracing::warn!("{}: no heartbeat ack; reconnecting", d.conn);
                    return Ok(());
                }
                acked = false;
                let seq = session.as_ref().and_then(|s| s.seq);
                sink.send(Message::Text(json!({"op": 1, "d": seq}).to_string().into())).await?;
            }
            Some(why) = w.fatal_rx.recv() => bail!(why),
        }
    }
}

/// One frame. False: this connection is over (Discord asked for a new one).
async fn on_frame(
    d: &Arc<Discord>,
    w: &Wiring,
    session: &mut Option<Session>,
    f: &Value,
    sink: &mut (impl futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    acked: &mut bool,
) -> Result<bool> {
    if let (Some(s), Some(seq)) = (session.as_mut(), f["s"].as_u64()) {
        s.seq = Some(seq);
    }
    match f["op"].as_u64() {
        Some(0) => dispatch(d, w, session, f),
        Some(1) => {
            let seq = session.as_ref().and_then(|s| s.seq);
            sink.send(Message::Text(json!({"op": 1, "d": seq}).to_string().into())).await?;
        }
        Some(7) => return Ok(false),
        Some(9) => {
            if f["d"] != true {
                *session = None;
            }
            sleep(Duration::from_secs(1) + Duration::from_millis(u64::from(rand_ms()))).await;
            return Ok(false);
        }
        Some(11) => *acked = true,
        _ => {}
    }
    Ok(true)
}

fn rand_ms() -> u16 {
    u16::try_from(uuid::Uuid::new_v4().as_u128() % 2000).unwrap_or(0)
}

fn dispatch(d: &Arc<Discord>, w: &Wiring, session: &mut Option<Session>, f: &Value) {
    let data = &f["d"];
    match f["t"].as_str() {
        Some("READY") => {
            let id = data["session_id"].as_str().unwrap_or_default().to_owned();
            let url = data["resume_gateway_url"].as_str().map_or_else(|| d.cfg.gateway_url.clone(), socket_url);
            *session = Some(Session { id, url, seq: f["s"].as_u64() });
            d.set_me(data["user"]["id"].as_str().unwrap_or_default(), data["application"]["id"].as_str());
            // Where the catch-up starts: read now, before a live message of this session can move it.
            let last = d.core.conn_state(&d.conn)["last"].as_u64().unwrap_or(0);
            let (me, tasks, fatal) = (d.clone(), w.tasks.clone(), w.fatal_tx.clone());
            w.tasks.spawn(async move {
                if let Err(e) = me.ready(&tasks, last).await {
                    let _ = fatal.send(format!("{e:#}"));
                }
            });
        }
        Some("CHANNEL_CREATE" | "CHANNEL_UPDATE" | "THREAD_CREATE" | "THREAD_UPDATE") => {
            d.channel_changed(data, false);
        }
        Some("CHANNEL_DELETE" | "THREAD_DELETE") => d.channel_changed(data, true),
        Some("RESUMED") => tracing::info!("{}: gateway resumed", d.conn),
        Some("MESSAGE_CREATE") => {
            let _ = w.messages.send(data.clone());
        }
        Some("INTERACTION_CREATE") => {
            let me = d.clone();
            let it = data.clone();
            w.tasks.spawn(async move { me.interaction(&it).await });
        }
        _ => {}
    }
}
