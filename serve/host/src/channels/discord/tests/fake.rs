//! A fake Discord for the adapter's tests: REST and a gateway websocket on one local port, with enough of the
//! real thing's behaviour (snowflakes, history, webhooks, threads, buttons, rate limits, a gateway that can go
//! silent or drop) to run the adapter through the real core.

use crate::LockExt;
use crate::channels::discord::api::time_snowflake;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

pub const GUILD: &str = "100";
pub const BOT: &str = "999";
pub const APP: &str = "888";
/// The server's owner, who is also Kai in the stub's people.
pub const OWNER: &str = "1001";
pub const GENERAL: &str = "200";
pub const DM: &str = "500";

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub body: Value,
}

/// Everything the bot or a webhook sent, as it stands now (edits applied, deleted ones marked).
#[derive(Clone, Debug)]
pub struct Post {
    pub id: String,
    /// Where it appears: a channel, or the thread a webhook posted into.
    pub channel: String,
    pub username: Option<String>,
    pub content: String,
    pub components: Value,
    pub files: Vec<(String, String)>,
    pub deleted: bool,
    pub via_webhook: Option<String>,
}

struct Hook {
    id: String,
    channel: String,
    token: String,
}

#[derive(Default)]
pub struct Fs {
    pub host: String,
    pub perms: String,
    pub guilds: Vec<(String, String)>,
    pub channels: Vec<Value>,
    roles: Vec<Value>,
    messages: BTreeMap<String, Vec<Value>>,
    hooks: Vec<Hook>,
    pub log: Vec<Req>,
    pub posts: Vec<Post>,
    pub typing: usize,
    last_id: u64,
    old: u64,
    seq: u64,
    events: Vec<(u64, String)>,
    /// (METHOD + " " + path part, status, body): answered once instead of the real thing.
    fail_once: Vec<(String, u16, Value)>,
}

pub struct Fd {
    pub st: Mutex<Fs>,
    events: broadcast::Sender<String>,
    pub hello_ms: AtomicU64,
    mute_gen: AtomicU64,
    kick_gen: AtomicU64,
    pub conns: AtomicUsize,
    pub identifies: AtomicUsize,
    pub resumes: AtomicUsize,
}

fn now_ms() -> u64 {
    u64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap()
}

impl Fs {
    pub fn new_id(&mut self) -> String {
        self.last_id = (self.last_id + 1).max(time_snowflake(now_ms()));
        self.last_id.to_string()
    }

    /// An id for a moment in the past (a message sent while the bot was away).
    fn id_at(&mut self, ms: u64) -> String {
        self.old += 1;
        (time_snowflake(ms) + self.old).to_string()
    }

    pub fn role_id(&self, name: &str) -> String {
        self.roles.iter().find(|r| r["name"] == name).and_then(|r| r["id"].as_str()).unwrap().to_owned()
    }

    pub fn messages_json(&self, channel: &str) -> Vec<Value> {
        self.messages.get(channel).cloned().unwrap_or_default()
    }

    pub fn channel(&self, id: &str) -> Option<&Value> {
        self.channels.iter().find(|c| c["id"] == id)
    }

    pub fn posts_in(&self, channel: &str) -> Vec<Post> {
        self.posts.iter().filter(|p| p.channel == channel && !p.deleted).cloned().collect()
    }

    pub fn id_of_channel(&self, name: &str) -> Option<String> {
        self.channels
            .iter()
            .find(|c| c["name"] == name && c["type"] != 11)
            .map(|c| c["id"].as_str().unwrap().to_owned())
    }

    fn hook_url(&self, h: &Hook) -> String {
        format!("{}/api/v10/webhooks/{}/{}", self.host, h.id, h.token)
    }

    pub fn hooks_of(&self, channel: &str) -> Vec<String> {
        self.hooks.iter().filter(|h| h.channel == channel).map(|h| self.hook_url(h)).collect()
    }

    pub fn requests(&self, method: &str, path_has: &str) -> Vec<Value> {
        self.log.iter().filter(|r| r.method == method && r.path.contains(path_has)).map(|r| r.body.clone()).collect()
    }
}

impl Fd {
    /// Starts it on a free port. `host` is `http://127.0.0.1:port`.
    pub async fn start() -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        let fd = Arc::new(Self {
            st: Mutex::new(Fs::default()),
            events,
            hello_ms: AtomicU64::new(150),
            mute_gen: AtomicU64::new(0),
            kick_gen: AtomicU64::new(0),
            conns: AtomicUsize::new(0),
            identifies: AtomicUsize::new(0),
            resumes: AtomicUsize::new(0),
        });
        let app = axum::Router::new().route("/gateway", get(ws)).fallback(rest).with_state(fd.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        {
            let mut st = fd.st.locked();
            st.host = format!("http://{}", listener.local_addr().unwrap());
            st.perms = (1u64 << 28).to_string();
            st.guilds = vec![(GUILD.into(), "Home".into())];
            st.channels = vec![
                json!({"id": GENERAL, "type": 0, "name": "general", "topic": "chat"}),
                json!({"id": DM, "type": 1, "recipients": [{"id": OWNER}]}),
            ];
        }
        tokio::spawn(async move { axum::serve(listener, app).await });
        fd
    }

    pub fn api_base(&self) -> String {
        format!("{}/api/v10", self.st.locked().host)
    }

    pub fn gateway_url(&self) -> String {
        format!("ws://{}/gateway", self.st.locked().host.trim_start_matches("http://"))
    }

    /// Makes the sockets open now go silent: they neither answer nor deliver, and stay open.
    pub fn mute(&self) {
        self.mute_gen.fetch_add(1, Ordering::SeqCst);
    }

    /// Closes the sockets open now.
    pub fn kick(&self) {
        self.kick_gen.fetch_add(1, Ordering::SeqCst);
    }

    pub fn fail_once(&self, key: &str, status: u16, body: Value) {
        self.st.locked().fail_once.push((key.to_owned(), status, body));
    }

    fn dispatch_locked(&self, st: &mut Fs, t: &str, d: &Value) {
        st.seq += 1;
        let frame = json!({"op": 0, "t": t, "s": st.seq, "d": d}).to_string();
        st.events.push((st.seq, frame.clone()));
        let _ = self.events.send(frame);
    }

    /// A message in a channel: stored for history; delivered live when `live`. `at_ms` back-dates it.
    pub fn say(
        &self,
        channel: &str,
        author: &str,
        text: &str,
        extra: &Value,
        live: bool,
        at_ms: Option<u64>,
    ) -> String {
        let mut st = self.st.locked();
        let id = match at_ms {
            Some(ms) => st.id_at(ms),
            None => st.new_id(),
        };
        let mut msg = json!({
            "id": id, "channel_id": channel, "author": {"id": author, "bot": false}, "content": text,
            "type": 0, "attachments": [],
        });
        if let Some(o) = extra.as_object() {
            for (k, v) in o {
                msg[k] = v.clone();
            }
        }
        st.messages.entry(channel.to_owned()).or_default().push(msg.clone());
        if live {
            let in_guild = st.channel(channel).is_some_and(|c| c["type"] != 1);
            if in_guild {
                msg["guild_id"] = json!(GUILD);
            }
            self.dispatch_locked(&mut st, "MESSAGE_CREATE", &msg);
        }
        id
    }

    /// Delivers a message again, as a gateway replay would.
    pub fn replay(&self, channel: &str, id: &str) {
        let mut st = self.st.locked();
        let mut msg = st.messages[channel].iter().find(|m| m["id"] == id).cloned().unwrap();
        if st.channel(channel).is_some_and(|c| c["type"] != 1) {
            msg["guild_id"] = json!(GUILD);
        }
        self.dispatch_locked(&mut st, "MESSAGE_CREATE", &msg);
    }

    /// Someone presses a button.
    pub fn press(&self, user: &str, custom_id: &str, message: &str) -> String {
        let mut st = self.st.locked();
        let token = format!("itok{}", st.seq + 1);
        let it = json!({
            "id": st.seq + 1000, "token": token, "type": 3, "application_id": APP,
            "data": {"custom_id": custom_id}, "member": {"user": {"id": user}}, "message": {"id": message},
        });
        self.dispatch_locked(&mut st, "INTERACTION_CREATE", &it);
        token
    }

    pub fn add_thread(&self, id: &str, parent: &str, name: &str) {
        self.st.locked().channels.push(json!({"id": id, "type": 11, "name": name, "parent_id": parent}));
    }

    /// A channel renamed: stored, and announced the way Discord does.
    pub fn rename(&self, id: &str, name: &str) {
        let mut st = self.st.locked();
        let Some(c) = st.channels.iter_mut().find(|c| c["id"] == id) else { return };
        c["name"] = json!(name);
        let c = c.clone();
        self.dispatch_locked(&mut st, "CHANNEL_UPDATE", &c);
    }

    pub fn register_hook(&self, id: &str, channel: &str, token: &str) {
        self.st.locked().hooks.push(Hook { id: id.into(), channel: channel.into(), token: token.into() });
    }

    pub fn forget_hooks(&self) {
        self.st.locked().hooks.clear();
    }
}

#[allow(clippy::unused_async)] // an axum handler
async fn ws(upgrade: WebSocketUpgrade, State(fd): State<Arc<Fd>>) -> Response {
    upgrade.on_upgrade(move |sock| connection(fd, sock))
}

async fn send(sock: &mut WebSocket, v: &Value) -> bool {
    sock.send(Message::Text(v.to_string().into())).await.is_ok()
}

async fn connection(fd: Arc<Fd>, mut sock: WebSocket) {
    let (mute, kick) = (fd.mute_gen.load(Ordering::SeqCst), fd.kick_gen.load(Ordering::SeqCst));
    let mut rx = fd.events.subscribe();
    fd.conns.fetch_add(1, Ordering::SeqCst);
    let hello = json!({"op": 10, "d": {"heartbeat_interval": fd.hello_ms.load(Ordering::SeqCst)}});
    if !send(&mut sock, &hello).await {
        return;
    }
    let Some(Ok(Message::Text(first))) = sock.recv().await else { return };
    let first: Value = serde_json::from_str(first.as_str()).unwrap();
    match first["op"].as_u64() {
        Some(2) => {
            fd.identifies.fetch_add(1, Ordering::SeqCst);
            let (url, seq) = {
                let mut st = fd.st.locked();
                st.seq += 1;
                (format!("ws://{}/gateway", st.host.trim_start_matches("http://")), st.seq)
            };
            let ready = json!({"op": 0, "t": "READY", "s": seq, "d": {
                "user": {"id": BOT}, "session_id": "sess1", "resume_gateway_url": url, "application": {"id": APP}}});
            if !send(&mut sock, &ready).await {
                return;
            }
        }
        Some(6) => {
            fd.resumes.fetch_add(1, Ordering::SeqCst);
            let after = first["d"]["seq"].as_u64().unwrap_or(0);
            if first["d"]["session_id"] != "sess1" {
                let _ = send(&mut sock, &json!({"op": 9, "d": false})).await;
                return;
            }
            let replay: Vec<String> =
                fd.st.locked().events.iter().filter(|(s, _)| *s > after).map(|(_, f)| f.clone()).collect();
            for f in replay {
                if sock.send(Message::Text(f.into())).await.is_err() {
                    return;
                }
            }
            if !send(&mut sock, &json!({"op": 0, "t": "RESUMED", "s": after, "d": {}})).await {
                return;
            }
        }
        _ => return,
    }
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    loop {
        let silent = fd.mute_gen.load(Ordering::SeqCst) > mute;
        tokio::select! {
            frame = sock.recv() => match frame {
                Some(Ok(Message::Text(t))) => {
                    let f: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                    if f["op"] == 1 && !silent && !send(&mut sock, &json!({"op": 11})).await {
                        return;
                    }
                }
                Some(Ok(_)) => {}
                _ => return,
            },
            ev = rx.recv() => {
                if let Ok(frame) = ev
                    && !silent
                    && sock.send(Message::Text(frame.into())).await.is_err()
                {
                    return;
                }
            }
            _ = tick.tick() => {
                if fd.kick_gen.load(Ordering::SeqCst) > kick {
                    return;
                }
            }
        }
    }
}

#[allow(clippy::unused_async)] // an axum handler
async fn rest(State(fd): State<Arc<Fd>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    if uri.path().starts_with("/cdn/") {
        return "attachment-bytes".into_response();
    }
    let ct = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let (status, v) = fd.route(&method, &uri, &ct, &body);
    if status == 204 {
        return StatusCode::NO_CONTENT.into_response();
    }
    (StatusCode::from_u16(status).unwrap(), axum::Json(v)).into_response()
}

/// A multipart body -> (`payload_json`, [(file name, text)]).
fn parse_multipart(ct: &str, body: &[u8]) -> (Value, Vec<(String, String)>) {
    let boundary = ct.split("boundary=").nth(1).unwrap_or("").to_owned();
    let text = String::from_utf8_lossy(body).into_owned();
    let mut payload = Value::Null;
    let mut files = Vec::new();
    for part in text.split(&format!("--{boundary}")).skip(1) {
        let Some((head, rest)) = part.split_once("\r\n\r\n") else { continue };
        let data = rest.strip_suffix("\r\n").unwrap_or(rest);
        if head.contains("name=\"payload_json\"") {
            payload = serde_json::from_str(data).unwrap_or(Value::Null);
        } else if let Some(name) = head.split("filename=\"").nth(1).and_then(|n| n.split('"').next()) {
            files.push((name.to_owned(), data.to_owned()));
        }
    }
    (payload, files)
}

impl Fd {
    #[allow(clippy::too_many_lines)]
    fn route(&self, method: &Method, uri: &Uri, ct: &str, body: &[u8]) -> (u16, Value) {
        let path = uri.path().trim_start_matches("/api/v10").to_owned();
        let query: BTreeMap<String, String> = uri
            .query()
            .unwrap_or("")
            .split('&')
            .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
            .collect();
        let (payload, files) = if ct.starts_with("multipart/") {
            parse_multipart(ct, body)
        } else {
            (serde_json::from_slice::<Value>(body).unwrap_or(Value::Null), Vec::new())
        };
        let m = method.as_str();
        let mut st = self.st.locked();
        st.log.push(Req { method: m.to_owned(), path: path.clone(), body: payload.clone() });
        let key = format!("{m} {path}");
        if let Some(i) = st.fail_once.iter().position(|(k, _, _)| key.contains(k.as_str())) {
            let (_, status, body) = st.fail_once.remove(i);
            return (status, body);
        }
        let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match (m, segs.as_slice()) {
            ("GET", ["users", "@me", "guilds"]) => {
                let perms = st.perms.clone();
                (
                    200,
                    json!(
                        st.guilds
                            .iter()
                            .map(|(id, name)| json!({"id": id, "name": name, "permissions": perms}))
                            .collect::<Vec<_>>()
                    ),
                )
            }
            ("GET", ["guilds", g]) => (200, json!({"id": g, "name": "Home", "owner_id": OWNER})),
            ("GET", ["guilds", _, "channels"]) => (
                200,
                json!(
                    st.channels.iter().filter(|c| !matches!(c["type"].as_u64(), Some(1 | 10..=12))).collect::<Vec<_>>()
                ),
            ),
            ("POST", ["guilds", _, "channels"]) => {
                let mut c = payload.clone();
                c["id"] = json!(st.new_id());
                st.channels.push(c.clone());
                (201, c)
            }
            ("GET", ["guilds", _, "roles"]) => (200, json!(st.roles)),
            ("POST", ["guilds", _, "roles"]) => {
                let mut r = payload.clone();
                r["id"] = json!(st.new_id());
                st.roles.push(r.clone());
                (200, r)
            }
            ("GET", ["guilds", _, "threads", "active"]) => {
                (200, json!({"threads": st.channels.iter().filter(|c| c["type"] == 11).collect::<Vec<_>>()}))
            }
            ("GET", ["channels", c]) => {
                st.channel(c).map_or((404, json!({"code": 10003, "message": "Unknown Channel"})), |v| (200, v.clone()))
            }
            ("PATCH", ["channels", c]) => {
                if let Some(ch) = st.channels.iter_mut().find(|ch| ch["id"] == *c) {
                    for (k, v) in payload.as_object().cloned().unwrap_or_default() {
                        ch[k] = v;
                    }
                    return (200, ch.clone());
                }
                (404, json!({"code": 10003, "message": "Unknown Channel"}))
            }
            ("GET", ["channels", c, "messages"]) => {
                let after: u64 = query.get("after").and_then(|a| a.parse().ok()).unwrap_or(0);
                let limit: usize = query.get("limit").and_then(|a| a.parse().ok()).unwrap_or(50);
                let mut all: Vec<Value> = st
                    .messages
                    .get(*c)
                    .into_iter()
                    .flatten()
                    .filter(|m| m["id"].as_str().and_then(|i| i.parse::<u64>().ok()).unwrap_or(0) > after)
                    .cloned()
                    .collect();
                all.sort_by_key(|m| m["id"].as_str().unwrap().parse::<u64>().unwrap());
                all.truncate(limit);
                all.reverse(); // newest first, as Discord answers
                (200, json!(all))
            }
            ("POST", ["channels", c, "messages"]) => {
                let id = st.new_id();
                let post = Post {
                    id: id.clone(),
                    channel: (*c).to_owned(),
                    username: None,
                    content: payload["content"].as_str().unwrap_or("").to_owned(),
                    components: payload["components"].clone(),
                    files,
                    deleted: false,
                    via_webhook: None,
                };
                let reply_to = payload["message_reference"]["message_id"].clone();
                st.posts.push(post);
                st.messages.entry((*c).to_owned()).or_default().push(
                    json!({"id": id, "channel_id": c, "author": {"id": BOT, "bot": true}, "content": payload["content"], "type": 0, "reply": reply_to}),
                );
                (200, json!({"id": id, "channel_id": c}))
            }
            ("PATCH" | "DELETE", ["channels", _, "messages", mid]) => edit_post(&mut st, mid, m == "DELETE", &payload),
            ("POST", ["channels", c, "messages", mid, "threads"]) => {
                let id = st.new_id();
                let t = json!({"id": id, "type": 11, "name": payload["name"], "parent_id": c, "from": mid});
                st.channels.push(t.clone());
                (201, t)
            }
            ("PUT", ["channels", c, "messages", mid, "reactions", emoji, "@me"]) => {
                st.log.push(Req { method: "REACT".into(), path: format!("{c}/{mid}/{emoji}"), body: Value::Null });
                (204, Value::Null)
            }
            ("POST", ["channels", _, "typing"]) => {
                st.typing += 1;
                (204, Value::Null)
            }
            ("GET", ["channels", c, "webhooks"]) => (
                200,
                json!(
                    st.hooks
                        .iter()
                        .filter(|h| h.channel == *c)
                        .map(|h| json!({"id": h.id, "name": "hq", "token": h.token}))
                        .collect::<Vec<_>>()
                ),
            ),
            ("POST", ["channels", c, "webhooks"]) => {
                let id = st.new_id();
                let token = format!("tok{id}");
                st.hooks.push(Hook { id: id.clone(), channel: (*c).to_owned(), token: token.clone() });
                (200, json!({"id": id, "name": payload["name"], "token": token}))
            }
            ("POST", ["webhooks", id, token]) => {
                let hook = st.hooks.iter().find(|h| h.id == *id && h.token == *token).map(|h| h.channel.clone());
                if hook.is_none() && *id != APP {
                    return (404, json!({"code": 10015, "message": "Unknown Webhook"}));
                }
                let channel = query.get("thread_id").cloned().or(hook).unwrap_or_default();
                let mid = st.new_id();
                st.posts.push(Post {
                    id: mid.clone(),
                    channel: channel.clone(),
                    username: payload["username"].as_str().map(str::to_owned),
                    content: payload["content"].as_str().unwrap_or("").to_owned(),
                    components: payload["components"].clone(),
                    files,
                    deleted: false,
                    via_webhook: Some((*id).to_owned()),
                });
                st.messages.entry(channel.clone()).or_default().push(
                    json!({"id": mid, "channel_id": channel, "webhook_id": id, "author": {"id": id, "bot": true}, "content": payload["content"], "type": 0}),
                );
                (200, json!({"id": mid, "channel_id": channel}))
            }
            ("PATCH" | "DELETE", ["webhooks", _, _, "messages", mid]) => {
                edit_post(&mut st, mid, m == "DELETE", &payload)
            }
            ("POST", ["interactions", _, _, "callback"]) => (204, Value::Null),
            _ => (404, json!({"code": 0, "message": format!("the fake has no {key}")})),
        }
    }
}

fn edit_post(st: &mut Fs, mid: &str, delete: bool, payload: &Value) -> (u16, Value) {
    if mid == "@original" {
        return (200, json!({"id": mid})); // a pressed button's message: the request log has the edit
    }
    if let Some(p) = st.posts.iter_mut().find(|p| p.id == mid) {
        if delete {
            p.deleted = true;
            return (204, Value::Null);
        }
        if let Some(c) = payload["content"].as_str() {
            c.clone_into(&mut p.content);
        }
        if payload.get("components").is_some() {
            p.components = payload["components"].clone();
        }
        return (200, json!({"id": mid}));
    }
    (404, json!({"code": 10008, "message": "Unknown Message"}))
}
