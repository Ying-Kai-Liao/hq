//! Telegram: a bot of hq's own (a `telegram/<name>` profile granted to the client `serve`), ported from
//! `kernel/lib/hq_bridge/telegram_chat.py`. Private chats and groups are rooms. `@agent …` or `/agent …` picks the
//! agent; a reply to a message of a task continues it; anything else goes to the room's default or the bot asks
//! who should take it. In a group the bot sees only commands, mentions of it and replies to it (Telegram's privacy
//! mode). Files come in as paths and go out with hq-send; answers are Markdown, shown as Telegram formatting.
//!
//! The bot token is in every Bot API URL: nothing here logs a URL or an unscrubbed error. The API's address is
//! `https://api.telegram.org`, or `KITH_TELEGRAM_API` (tests, a local Bot API server).

mod api;
mod format;

#[cfg(test)]
mod tests;

use super::adapter::{Adapter, Alive, Constructor, Ended, Fut, Incoming, Reaction, Secrets, StopPress};
use super::core::Core;
use super::text::first_chars;
use crate::LockExt;
use anyhow::{Result, anyhow};
use api::{Api, CALL, TgError};
use format::{escape, tg_html};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_API: &str = "https://api.telegram.org";
/// Telegram allows only its own short list of reaction emoji.
const STOP_EMOJI: &str = "🫡";
const REDO_EMOJI: &str = "✍";
/// How much of an answer goes into one message (4096 after formatting).
const CHUNK: usize = 3000;
const FOOTER: &str = "\n\n(From Telegram: your final answer is posted here automatically; Markdown shows as formatting. Send images and files with hq-send; files the user sent are listed as paths. Helpers you call post status with `hq-send --as <their name>`.)";
/// How often the agents are looked at again for the / menu.
const MENU_REFRESH: Duration = Duration::from_secs(60);

/// How long to wait after a failed poll.
#[derive(Clone, Copy, Debug)]
pub struct Pace {
    /// Another program reads this bot's updates (409); doubles up to four times this.
    pub conflict: Duration,
    /// Anything else that went wrong.
    pub error: Duration,
    /// A poll that waits for updates this long on Telegram's side.
    pub long_poll_s: u64,
    /// How long a button press waits for the core before Telegram is answered without its verdict.
    pub pick_wait: Duration,
    /// Files above this many bytes are not downloaded (the cloud Bot API's getFile limit).
    pub max_file: u64,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            conflict: Duration::from_secs(30),
            error: Duration::from_secs(15),
            long_poll_s: 50,
            pick_wait: Duration::from_secs(2),
            max_file: 20 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Default)]
struct Me {
    username: String,
    id: i64,
}

pub struct Telegram {
    conn: String,
    api: Api,
    core: Arc<Core>,
    alive: Alive,
    me: Mutex<Me>,
    /// The / menu as last set.
    menu: Mutex<Value>,
    pub pace: Pace,
    /// A poll returns within 70 s, a failed one is retried after at most 30 s.
    pub quiet: Duration,
}

/// The adapter of the `telegram` platform, for [`super::Registry`].
pub fn constructor() -> Constructor {
    Arc::new(|conn, secrets: Secrets, core| {
        let token = secrets.get("TELEGRAM_BOT_TOKEN").ok_or_else(|| anyhow!("TELEGRAM_BOT_TOKEN is not set"))?;
        let base = std::env::var("KITH_TELEGRAM_API").ok().filter(|b| !b.is_empty());
        Ok(Arc::new(Telegram::new(conn, token, base.as_deref().unwrap_or(DEFAULT_API), core)) as Arc<dyn Adapter>)
    })
}

/// A chat or message id as the text the core keys its rooms and replies by.
fn id_text(v: &Value) -> String {
    v.as_i64().map_or_else(|| v.as_str().unwrap_or("").to_owned(), |n| n.to_string())
}

impl Telegram {
    pub fn new(conn: &str, token: &str, base: &str, core: Arc<Core>) -> Self {
        Self {
            conn: conn.to_owned(),
            api: Api::new(base, token),
            core,
            alive: Alive::default(),
            me: Mutex::new(Me::default()),
            menu: Mutex::new(Value::Null),
            pace: Pace::default(),
            quiet: Duration::from_secs(300),
        }
    }

    fn me(&self) -> Me {
        self.me.locked().clone()
    }

    /// A call whose failure only matters to the caller.
    async fn tg(&self, method: &str, params: Value) -> Result<Value, TgError> {
        self.api.call_retry(method, &params).await
    }

    /// Sends a message -> it, or None (logged). With `parse_mode` set, a refusal by Telegram is an error: the caller
    /// sends the text plain.
    async fn send(&self, chat: &Value, text: &str, to: Option<i64>, extra: Value) -> Result<Option<Value>, TgError> {
        let mut params = json!({"chat_id": chat, "text": text});
        if let Some(to) = to {
            params["reply_parameters"] = json!({"message_id": to, "allow_sending_without_reply": true});
        }
        if let (Some(params), Value::Object(extra)) = (params.as_object_mut(), extra) {
            params.extend(extra);
        }
        let formatted = params.get("parse_mode").is_some();
        match self.tg("sendMessage", params).await {
            Ok(sent) => Ok(Some(sent)),
            Err(e @ TgError::Http { .. }) if formatted => Err(e),
            Err(e) => {
                tracing::warn!("{}: send failed: {e}", self.conn);
                Ok(None)
            }
        }
    }

    /// Cosmetic edits: a message that is gone or unchanged is not an error.
    async fn edit(&self, chat: &Value, message: &Value, text: &str, markup: Option<&Value>) {
        let mut params = json!({"chat_id": chat, "message_id": message, "text": text, "parse_mode": "HTML"});
        if let Some(markup) = markup {
            params["reply_markup"] = markup.clone();
        }
        if let Err(e) = self.tg("editMessageText", params).await {
            tracing::debug!("{}: edit failed: {e}", self.conn);
        }
    }

    fn save(&self) {
        self.core.with(super::core::Inner::save);
    }

    fn link(&self, chat: &Value, message: &Value, key: &str) {
        self.core.link_reply(&self.conn, &id_text(chat), &id_text(message), key);
    }

    // ---- the connection ----

    /// The / menu: one command per agent, plus hq's own.
    fn menu_now(&self) -> Value {
        let valid = |name: &str| {
            (1..=32).contains(&name.len()) && name.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
        };
        let mut commands: Vec<Value> = self
            .core
            .agents()
            .iter()
            .map(|a| (Core::cmd_name(a), first_chars(&self.core.description(a), 250).to_owned()))
            .filter(|(name, description)| valid(name) && !description.is_empty())
            .take(90)
            .map(|(command, description)| json!({"command": command, "description": description}))
            .collect();
        commands.extend([
            json!({"command": "agents", "description": "the agents you can use"}),
            json!({"command": "default", "description": "which agent answers messages without @agent here"}),
            json!({"command": "stop", "description": "stop the agent working on this (reply to its message)"}),
            json!({"command": "whoami", "description": "who you are in hq"}),
        ]);
        Value::Array(commands)
    }

    async fn set_menu(&self) {
        let menu = self.menu_now();
        if *self.menu.locked() == menu {
            return;
        }
        // The menu is a convenience: a failure is tried again with the next refresh.
        match self.tg("setMyCommands", json!({"commands": menu})).await {
            Ok(_) => *self.menu.locked() = menu,
            Err(e) => tracing::warn!("{}: commands not set: {e}", self.conn),
        }
    }

    async fn run(self: &Arc<Self>) -> Result<()> {
        let me = self.api.call("getMe", &json!({}), CALL).await?;
        *self.me.locked() =
            Me { username: me["username"].as_str().unwrap_or("").to_owned(), id: me["id"].as_i64().unwrap_or(0) };
        tracing::info!("{}: as @{}", self.conn, self.me().username);
        *self.menu.locked() = Value::Null;
        self.set_menu().await;
        let this: Arc<dyn Adapter> = self.clone();
        self.core.resume(&this);
        // Telegram keeps what came while we were away (24 h) until it is confirmed.
        let mut offset = self.core.conn_state(&self.conn)["offset"].as_i64().unwrap_or(0);
        let mut conflict = self.pace.conflict;
        let mut menu_checked = Instant::now();
        loop {
            self.alive.touch();
            if menu_checked.elapsed() > MENU_REFRESH {
                menu_checked = Instant::now();
                self.set_menu().await;
            }
            let polled = self
                .api
                .call(
                    "getUpdates",
                    &json!({"offset": offset, "timeout": self.pace.long_poll_s, "allowed_updates": ["message", "callback_query"]}),
                    CALL,
                )
                .await;
            let updates = match polled {
                Ok(updates) => {
                    conflict = self.pace.conflict;
                    updates
                }
                Err(e @ TgError::Http { code: 401 | 404, .. }) => return Err(e.into()), // the token is wrong or revoked
                Err(TgError::Http { code: 409, .. }) => {
                    self.alive.touch(); // Telegram answered; the other poller is the problem
                    tracing::warn!(
                        "{}: poll failed: 409 (another program reads this bot's updates, the bridge or a second host?); trying again in {}s",
                        self.conn,
                        conflict.as_secs_f32()
                    );
                    tokio::time::sleep(conflict).await;
                    conflict = (conflict * 2).min(self.pace.conflict * 4);
                    continue;
                }
                Err(TgError::Http { code: 429, retry_after, .. }) => {
                    self.alive.touch();
                    let wait = Duration::from_secs(retry_after.unwrap_or(5).clamp(1, 120));
                    tracing::warn!("{}: poll failed: 429 (too many requests); waiting {}s", self.conn, wait.as_secs());
                    tokio::time::sleep(wait).await;
                    continue;
                }
                Err(e) => {
                    tracing::warn!("{}: poll failed: {e}", self.conn);
                    tokio::time::sleep(self.pace.error).await;
                    continue;
                }
            };
            self.alive.touch();
            for u in updates.as_array().into_iter().flatten() {
                self.alive.touch();
                let Some(id) = u["update_id"].as_i64() else { continue };
                // A stuck update (a hanging hq-auth, a slow download) must end before the supervisor decides the
                // connection is dead: it would be aborted mid-way and replayed after every restart.
                match tokio::time::timeout(self.handle_limit(), self.update(&this, u)).await {
                    Ok(Ok(())) => {}
                    // One bad message must not stop the bot.
                    Ok(Err(e)) => tracing::warn!("{}: message failed: {e:#}", self.conn),
                    Err(_) => tracing::warn!("{}: update {id} took too long; moving on", self.conn),
                }
                self.alive.touch();
                // Only now that its work is queued (and saved by the core): confirming it earlier would let another
                // save record the offset without the task, and a restart would skip the message. A crash right here
                // answers it again instead.
                offset = id + 1;
                self.core.update_conn(&self.conn, |c| c["offset"] = json!(offset));
            }
        }
    }

    /// How long one update may take: well under `quiet`.
    fn handle_limit(&self) -> Duration {
        self.quiet.saturating_sub(Duration::from_secs(30)).max(self.quiet / 2)
    }

    async fn update(self: &Arc<Self>, this: &Arc<dyn Adapter>, u: &Value) -> Result<()> {
        if let Some(message) = u.get("message").filter(|m| m.is_object()) {
            if let Some(m) = self.incoming(message).await {
                self.core.handle(this, &m).await?;
            }
        } else if let Some(query) = u.get("callback_query").filter(|q| q.is_object()) {
            self.button(this, query).await;
        }
        Ok(())
    }

    // ---- messages in ----

    async fn incoming(&self, m: &Value) -> Option<Incoming> {
        let (sender, chat) = (&m["from"], &m["chat"]);
        if sender["is_bot"] == true || sender["id"].is_null() || !m["sender_chat"].is_null() {
            return None; // bots, and anonymous admins or channels posting as the group: no person behind them
        }
        let text = [&m["text"], &m["caption"]].iter().find_map(|t| t.as_str().filter(|t| !t.is_empty())).unwrap_or("");
        let private = chat["type"] == "private";
        let (cid, mid) = (&chat["id"], &m["message_id"]);
        let me = self.me();
        if let Some(bot) = command_target(text)
            && !bot.eq_ignore_ascii_case(&me.username)
        {
            return None; // a command for another bot in the group
        }
        let mut addressed = private
            || text.trim_start().starts_with('/')
            || text.to_lowercase().contains(&format!("@{}", me.username).to_lowercase());
        let text = without_mention(text, &me.username);
        let replied = &m["reply_to_message"];
        let (mut thread, mut quoted) = (None, String::new());
        if replied.is_object() {
            thread = self.core.replied_thread(&self.conn, &id_text(cid), &id_text(&replied["message_id"]));
            addressed = addressed || replied["from"]["id"].as_i64() == Some(me.id);
            if thread.is_none() {
                quoted = [&replied["text"], &replied["caption"]]
                    .iter()
                    .find_map(|t| t.as_str().filter(|t| !t.is_empty()))
                    .unwrap_or("")
                    .to_owned();
            }
        }
        if !(private || addressed || thread.is_some()) {
            return None;
        }
        let (files, notes) = self.download(m).await;
        let text = notes.iter().fold(text, |t, n| if t.is_empty() { n.clone() } else { format!("{t}\n\n{n}") });
        Some(Incoming {
            uid: id_text(&sender["id"]),
            text,
            room: format!("{}:{}", self.conn, id_text(cid)),
            origin: json!({"chat": cid, "message": mid}),
            thread,
            private,
            addressed,
            quoted,
            files,
            reference: json!({"chat": cid, "message": mid}),
            sent: m["date"].as_f64(),
            ..Incoming::default()
        })
    }

    /// The files of a message, saved under the connection's attachments folder (`<chat>/<message>`: message ids
    /// are only unique within a chat) -> their paths.
    /// Files over the size limit are not fetched: the agent is told instead (second value).
    async fn download(&self, m: &Value) -> (Vec<String>, Vec<String>) {
        let (mut got, mut notes) = (Vec::new(), Vec::new());
        let photo = m["photo"].as_array().and_then(|p| p.last());
        let kinds = [
            ("photo", photo),
            ("document", m.get("document")),
            ("audio", m.get("audio")),
            ("voice", m.get("voice")),
            ("video", m.get("video")),
            ("video_note", m.get("video_note")),
        ];
        for (kind, file) in kinds {
            let Some(file) = file.filter(|f| f.is_object()) else { continue };
            self.alive.touch(); // a message with several files can take longer than a poll
            let named = file["file_name"].as_str().unwrap_or(kind);
            if file["file_size"].as_u64().is_some_and(|n| n > self.pace.max_file) {
                notes.push(format!("(file too big: {named})"));
                continue;
            }
            match self.fetch(kind, file, &m["chat"]["id"], &m["message_id"]).await {
                Ok(path) => got.push(path),
                Err(e) if e.to_string().contains("file too big") => notes.push(format!("(file too big: {named})")),
                // Gone, or over what getFile gives bots.
                Err(e) => tracing::warn!("{}: file not downloaded: {e}", self.conn),
            }
        }
        self.alive.touch();
        (got, notes)
    }

    async fn fetch(&self, kind: &str, file: &Value, chat: &Value, message: &Value) -> Result<String> {
        let id = file["file_id"].as_str().ok_or_else(|| anyhow!("no file id"))?;
        let got = self.tg("getFile", json!({"file_id": id})).await?;
        let remote = got["file_path"].as_str().ok_or_else(|| anyhow!("no file path"))?;
        let folder = self.core.attachments_dir(&self.conn).join(id_text(chat)).join(id_text(message));
        tokio::fs::create_dir_all(&folder).await?;
        // The sender chooses a document's name: only its last part counts.
        let named = file["file_name"].as_str().and_then(|n| Path::new(n).file_name()).filter(|n| !n.is_empty());
        let name = named.map_or_else(
            || {
                let ext =
                    Path::new(remote).extension().map_or_else(String::new, |e| format!(".{}", e.to_string_lossy()));
                format!("{kind}{ext}").into()
            },
            std::ffi::OsStr::to_os_string,
        );
        let dest = folder.join(name);
        self.api.download(remote, &dest, self.pace.max_file).await?;
        Ok(dest.to_string_lossy().into_owned())
    }

    /// A press on an inline button.
    async fn button(self: &Arc<Self>, this: &Arc<dyn Adapter>, q: &Value) {
        let data = q["data"].as_str().unwrap_or("");
        let msg = &q["message"];
        let (chat, mid) = (&msg["chat"]["id"], &msg["message_id"]);
        let uid = id_text(&q["from"]["id"]);
        let mut not_yours = false;
        if let Some(wid) = data.strip_prefix("stop:") {
            let pressed = self.core.stop_pressed(this, wid, &uid).await;
            self.answer_press(q, pressed == StopPress::NotYours).await; // Telegram's window for this is short
            if pressed == StopPress::Stopping {
                self.edit(chat, mid, "<i>stopping…</i>", None).await;
            }
            return;
        } else if let Some(pick) = data.strip_prefix("pick:").filter(|p| p.matches(':').count() == 1) {
            let (pid, agent) = pick.split_once(':').unwrap_or_default();
            // Starting the task can take a while: if the core hasn't said yes or no soon, answer Telegram anyway
            // and let it finish.
            let mut task = tokio::spawn({
                let (me, core, this) = (self.clone(), self.core.clone(), this.clone());
                let (pid, agent, uid) = (pid.to_owned(), agent.to_owned(), uid.clone());
                let (chat, mid) = (chat.clone(), mid.clone());
                async move {
                    let picked = core.picked(&this, &pid, &agent, &uid).await;
                    match &picked {
                        Ok(true) => me.edit(&chat, &mid, &format!("→ {}", escape(&agent, true)), None).await,
                        Ok(false) => {}
                        Err(e) => tracing::warn!("{}: pick failed: {e:#}", me.conn),
                    }
                    matches!(picked, Ok(false))
                }
            });
            not_yours = matches!(tokio::time::timeout(self.pace.pick_wait, &mut task).await, Ok(Ok(true)));
        }
        self.answer_press(q, not_yours).await;
    }

    async fn answer_press(&self, q: &Value, not_yours: bool) {
        let mut answer = json!({"callback_query_id": q["id"]});
        if not_yours {
            answer["text"] = json!("Only the person who asked can do that.");
        }
        let _ = self.tg("answerCallbackQuery", answer).await;
    }
}

/// `/command@bot …` -> the bot the command is for.
fn command_target(text: &str) -> Option<String> {
    let rest = text.trim_start().strip_prefix('/')?;
    let name_len = rest.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(rest.len());
    let after = rest[name_len..].strip_prefix('@').filter(|_| name_len > 0)?;
    let bot: String = after.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    (!bot.is_empty()).then_some(bot)
}

/// `text` without `@bot` (any case, as a whole word), trimmed.
fn without_mention(text: &str, bot: &str) -> String {
    let (lower, mention) = (text.to_ascii_lowercase(), format!("@{}", bot.to_ascii_lowercase()));
    let mut out = String::new();
    let mut at = 0;
    while let Some(found) = lower[at..].find(&mention).map(|f| f + at) {
        let end = found + mention.len();
        let word_next = text[end..].chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_');
        out += &text[at..found];
        if word_next {
            out += &text[found..end];
        }
        at = end;
    }
    out += &text[at..];
    out.trim().to_owned()
}

impl Adapter for Telegram {
    fn platform(&self) -> &'static str {
        "telegram"
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
            let sent = self.send(&m.origin["chat"], text, m.origin["message"].as_i64(), json!({})).await?;
            // A note inside a task's thread belongs to it: replying to it goes on with the task.
            if let (Some(sent), Some(key)) = (sent, m.thread.as_deref().filter(|k| self.core.has_thread(k))) {
                self.link(&m.origin["chat"], &sent["message_id"], key);
            }
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
            let (chat, message) = (&m.origin["chat"], &m.origin["message"]);
            let key = format!("{}:{}:{}", self.conn, id_text(chat), id_text(message));
            self.link(chat, message, &key);
            Ok((key, json!({"chat": chat, "reply_to": message})))
        })
    }

    fn follow(&self, conv: &Value, m: &Incoming) -> Value {
        self.link(&conv["chat"], &m.origin["message"], conv["key"].as_str().unwrap_or(""));
        let mut next = conv.clone();
        next["reply_to"] = m.origin["message"].clone(); // the answer replies to the newest message
        next
    }

    fn post<'a>(&'a self, conv: &'a Value, agent: &'a str, text: &'a str, ctx_pct: Option<f64>) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            let text = ctx_pct.map_or_else(|| text.to_owned(), |ctx| format!("{text}\n\n_context {ctx:.0}%_"));
            let (chat, to, name) = (&conv["chat"], conv["reply_to"].as_i64(), self.core.display_name(agent));
            for (i, part) in Core::chunks(&text, CHUNK).iter().enumerate() {
                let head = if i == 0 { format!("<b>{}</b>\n", escape(&name, true)) } else { String::new() };
                let formatted = format!("{head}{}", tg_html(part));
                let mut sent = self.send(chat, &formatted, to, json!({"parse_mode": "HTML"})).await;
                if sent.is_err() {
                    // Formatting Telegram can't parse: plain.
                    let head = if i == 0 { format!("{name}\n") } else { String::new() };
                    sent = self.send(chat, &format!("{head}{part}"), to, json!({})).await;
                }
                let sent = sent.unwrap_or(None);
                if let Some(sent) = sent {
                    self.link(chat, &sent["message_id"], conv["key"].as_str().unwrap_or(""));
                }
            }
            self.save();
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
            let name = self.core.display_name(agent);
            let mut caption = if caption.is_empty() { name } else { format!("{name}: {caption}") };
            for f in files {
                let path = Path::new(f);
                if !path.is_file() {
                    continue;
                }
                let image = ["png", "jpg", "jpeg", "webp"]
                    .iter()
                    .any(|e| path.extension().is_some_and(|x| x.eq_ignore_ascii_case(e)));
                let photo = image && path.metadata().is_ok_and(|m| m.len() < 10_000_000);
                let (method, field) = if photo { ("sendPhoto", "photo") } else { ("sendDocument", "document") };
                let mut params = json!({"chat_id": conv["chat"], "caption": first_chars(&caption, 1000)});
                if let Some(to) = conv["reply_to"].as_i64() {
                    params["reply_parameters"] = json!({"message_id": to, "allow_sending_without_reply": true});
                }
                match self.api.upload_retry(method, &params, field, f).await {
                    Ok(sent) => self.link(&conv["chat"], &sent["message_id"], conv["key"].as_str().unwrap_or("")),
                    Err(e) => tracing::warn!("{}: file not sent: {e}", self.conn),
                }
                caption.clear(); // on the first one only
            }
            self.save();
            Ok(())
        })
    }

    fn status<'a>(&'a self, conv: &'a Value, _agent: &'a str, wid: &'a str) -> Fut<'a, Result<Value>> {
        Box::pin(async move {
            let stop = json!({"inline_keyboard": [[{"text": "Stop", "callback_data": format!("stop:{wid}")}]]});
            let extra = json!({"reply_markup": stop, "disable_notification": true});
            let sent = self.send(&conv["chat"], "working…", conv["reply_to"].as_i64(), extra).await?;
            if let Some(sent) = &sent {
                // Replying to the working line goes on with the task, not a new one quoting "working…".
                self.link(&conv["chat"], &sent["message_id"], conv["key"].as_str().unwrap_or(""));
            }
            Ok(sent.map_or(Value::Null, |s| json!({"chat": conv["chat"], "message_id": s["message_id"], "stop": stop})))
        })
    }

    fn status_text<'a>(&'a self, handle: &'a Value, text: &'a str) -> Fut<'a, ()> {
        Box::pin(async move {
            if handle.is_object() {
                let stop = (!text.contains("restarting")).then(|| &handle["stop"]);
                self.edit(&handle["chat"], &handle["message_id"], &escape(text, true), stop).await;
            }
        })
    }

    fn status_end<'a>(&'a self, conv: &'a Value, _agent: &'a str, handle: &'a Value, ended: Ended) -> Fut<'a, ()> {
        Box::pin(async move {
            let has = handle.is_object();
            if ended == Ended::Stopped {
                if has {
                    self.edit(&handle["chat"], &handle["message_id"], "<i>stopped</i>", None).await;
                } else {
                    let extra = json!({"disable_notification": true});
                    let sent = self.send(&conv["chat"], "stopped", conv["reply_to"].as_i64(), extra).await;
                    if let Ok(Some(sent)) = sent {
                        self.link(&conv["chat"], &sent["message_id"], conv["key"].as_str().unwrap_or(""));
                    }
                }
            } else if has {
                let gone = json!({"chat_id": handle["chat"], "message_id": handle["message_id"]});
                let _ = self.tg("deleteMessage", gone).await; // cosmetic
            }
        })
    }

    fn react<'a>(&'a self, m: &'a Incoming, what: Reaction) -> Fut<'a, ()> {
        Box::pin(async move {
            if m.reference.is_object() {
                let emoji = match what {
                    Reaction::Stop => STOP_EMOJI,
                    Reaction::Redo => REDO_EMOJI,
                };
                let params = json!({"chat_id": m.reference["chat"], "message_id": m.reference["message"],
                                    "reaction": [{"type": "emoji", "emoji": emoji}]});
                let _ = self.tg("setMessageReaction", params).await; // cosmetic
            }
        })
    }

    fn ask<'a>(&'a self, m: &'a Incoming, pid: &'a str, agents: &'a [String]) -> Fut<'a, Result<()>> {
        Box::pin(async move {
            let rows: Vec<Vec<Value>> = agents
                .chunks(3)
                .map(|row| row.iter().map(|a| json!({"text": a, "callback_data": format!("pick:{pid}:{a}")})).collect())
                .collect();
            let extra = json!({"reply_markup": {"inline_keyboard": rows}});
            self.send(&m.origin["chat"], "Who should take this?", m.origin["message"].as_i64(), extra).await?;
            Ok(())
        })
    }

    fn typing<'a>(&'a self, conv: &'a Value) -> Fut<'a, ()> {
        Box::pin(async move {
            loop {
                let _ = self.tg("sendChatAction", json!({"chat_id": conv["chat"], "action": "typing"})).await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        })
    }
}
