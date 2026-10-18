//! A bot's memory writes show in its chat: a "Remembered" line the user can undo, or, for a bot that asks before
//! acting, a card the user approves or declines. The line is an ordinary notice whose `memory` field says what
//! happened, so an app that doesn't know it still shows the text.

use crate::hub::Hub;
use crate::store::{BotConfig, EntryKind, Lane};
use anyhow::{Result, anyhow, bail};
use codync_mem::store::{self as mem, Author, Entry, Error, New, Writer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Action {
    Remember {
        text: String,
        #[serde(default)]
        shared: bool,
    },
    Revise {
        entry: i64,
        text: String,
    },
    Archive {
        entry: i64,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Written; the user can undo it.
    Done,
    /// Waiting for the user's approval.
    Pending,
    Accepted,
    Declined,
    Undone,
    /// Approved, but the write was refused (the layer is full, say).
    Failed,
}

/// The runs of a user message the user typed themselves: not pasted, quoted or forwarded text.
pub fn typed(data: &Value) -> Vec<String> {
    let pasted: Vec<String> =
        data["pasted"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(str::to_owned)).collect();
    codync_mem::evidence::typed(data["text"].as_str().unwrap_or_default(), &pasted)
}

/// Writes now, and says so in the chat with an undo.
pub fn apply(
    hub: &Hub,
    cfg: &BotConfig,
    lane: Option<Lane>,
    message: Option<String>,
    action: &Action,
) -> Result<Entry> {
    let lane = lane.unwrap_or_else(|| Lane::main(&cfg.id));
    let (entry, previous) = write(hub, cfg, &lane, message.clone(), action)?;
    let card = Card { status: Status::Done, entry: Some(entry.id), previous, message, error: None };
    post(hub, cfg, &lane, action, &card);
    super::changed(hub, entry.bot.as_deref());
    Ok(entry)
}

/// Asks the user first: a card in the chat. The text is checked now, so the bot hears a refusal at once, and
/// again when the user approves.
pub fn propose(hub: &Hub, cfg: &BotConfig, lane: Option<Lane>, message: Option<String>, action: &Action) -> Result<()> {
    let lane = lane.unwrap_or_else(|| Lane::main(&cfg.id));
    let shared = super::shared(cfg);
    let previous = match action {
        Action::Remember { text, shared: wants } => {
            let layer = (!(*wants && shared)).then_some(cfg.id.as_str());
            hub.store.memory_read(|c| mem::admissible(c, Writer::Bot(&cfg.id), layer, text))?;
            None
        }
        Action::Revise { entry, .. } | Action::Archive { entry } => {
            if let Action::Revise { text, .. } = action {
                codync_mem::check::text(text)?;
            }
            let current = hub.store.memory_read(|c| visible(c, *entry, &cfg.id, shared))?;
            if current.author == Author::User {
                return Err(Error::UsersOwn.into());
            }
            Some(current.text)
        }
    };
    let card = Card { status: Status::Pending, entry: None, previous, message, error: None };
    post(hub, cfg, &lane, action, &card);
    Ok(())
}

/// The user approved or declined a card.
pub fn answer(hub: &Hub, notice_id: &str, accept: bool) -> Result<Value> {
    let (notice, cfg, action, mut card) = open(hub, notice_id)?;
    if card.status != Status::Pending {
        bail!("This card was already answered.");
    }
    let lane = Lane { chat: notice.bot_id.clone(), thread: notice.thread_id.clone() };
    if accept {
        match write(hub, &cfg, &lane, card.message.clone(), &action) {
            Ok((entry, previous)) => {
                card.status = Status::Accepted;
                card.entry = Some(entry.id);
                card.previous = previous.or(card.previous);
                super::changed(hub, entry.bot.as_deref());
            }
            // Dreaming may have learned it meanwhile: it's remembered either way.
            Err(error)
                if matches!(
                    error.downcast_ref::<Error>(),
                    Some(Error::Refused(codync_mem::check::Refusal::Duplicate))
                ) =>
            {
                card.status = Status::Accepted;
            }
            Err(error) => {
                card.status = Status::Failed;
                card.error = Some(format!("{error:#}"));
            }
        }
    } else {
        card.status = Status::Declined;
        if let Action::Remember { text, shared } = &action {
            let layer = (!(*shared && super::shared(&cfg))).then_some(cfg.id.as_str());
            hub.store.memory_write(|c, _, _| mem::forbid(c, layer, text, card.message.as_deref()))?;
        }
    }
    Ok(update(hub, &notice, &cfg, &action, &card))
}

/// The user took back what a bot wrote.
pub fn undo(hub: &Hub, notice_id: &str) -> Result<Value> {
    let (notice, cfg, action, mut card) = open(hub, notice_id)?;
    let id = card.entry.filter(|_| matches!(card.status, Status::Done | Status::Accepted));
    let id = id.ok_or_else(|| anyhow!("There's nothing to undo."))?;
    let previous = card.previous.clone();
    let layer = hub.store.memory_write(|c, now, rev| {
        let entry = mem::get(c, id)?.ok_or(Error::NotFound)?;
        match &action {
            Action::Remember { .. } => {
                mem::forget(c, id)?;
            }
            Action::Revise { .. } => {
                mem::revise(c, Writer::User, id, previous.as_deref().unwrap_or(&entry.text), now, rev)?;
            }
            Action::Archive { .. } => {
                mem::activate(c, id, now, rev)?;
            }
        }
        Ok(entry.bot)
    })?;
    card.status = Status::Undone;
    super::changed(hub, layer.as_deref());
    Ok(update(hub, &notice, &cfg, &action, &card))
}

/// What a card records beside its action.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Card {
    status: Status,
    /// The memory entry written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entry: Option<i64>,
    /// The text before a revision, or of the entry being archived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<String>,
    /// The user's message the turn answered: where the fact was learned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn write(
    hub: &Hub,
    cfg: &BotConfig,
    lane: &Lane,
    message: Option<String>,
    action: &Action,
) -> Result<(Entry, Option<String>)> {
    let bot = cfg.id.as_str();
    let shared = super::shared(cfg);
    let room = (lane.chat != cfg.id).then(|| lane.chat.clone());
    let evidence: Vec<String> = message.into_iter().collect();
    let writer = Writer::Bot(bot);
    hub.store.memory_write(|c, now, rev| match action {
        Action::Remember { text, shared: wants } => {
            let layer = (!(*wants && shared)).then_some(bot);
            let new = New { bot: layer, text, room: room.as_deref(), evidence: &evidence };
            mem::add(c, writer, new, now, rev).map(|e| (e, None))
        }
        Action::Revise { entry, text } => {
            let old = visible(c, *entry, bot, shared)?;
            mem::revise(c, writer, *entry, text, now, rev).map(|e| (e, Some(old.text)))
        }
        Action::Archive { entry } => {
            let old = visible(c, *entry, bot, shared)?;
            mem::archive(c, writer, *entry, None, now, rev).map(|e| (e, Some(old.text)))
        }
    })
}

/// An entry in this bot's own layer, or in the shared one when the bot uses it.
fn visible(c: &rusqlite::Connection, id: i64, bot: &str, shared: bool) -> mem::Result<Entry> {
    let entry = mem::get(c, id)?.ok_or(Error::NotFound)?;
    if entry.bot.as_deref() == Some(bot) || (entry.bot.is_none() && shared) { Ok(entry) } else { Err(Error::NotFound) }
}

fn post(hub: &Hub, cfg: &BotConfig, lane: &Lane, action: &Action, card: &Card) {
    let turn = hub.store.max_turn(&lane.chat);
    hub.add_entry(lane, EntryKind::Notice, turn, &data(cfg, action, card));
}

fn update(hub: &Hub, notice: &crate::store::Entry, cfg: &BotConfig, action: &Action, card: &Card) -> Value {
    let mut data = notice.data.clone();
    let fresh = self::data(cfg, action, card);
    data["text"] = fresh["text"].clone();
    data["memory"] = fresh["memory"].clone();
    hub.set_entry(&notice.id, &data).map_or(Value::Null, |e| json!({"entry": e}))
}

fn data(cfg: &BotConfig, action: &Action, card: &Card) -> Value {
    let mut memory = serde_json::to_value(action).expect("an action is plain data");
    if let (Some(memory), Value::Object(card)) =
        (memory.as_object_mut(), serde_json::to_value(card).expect("a card is plain data"))
    {
        memory.extend(card);
    }
    json!({"text": summary(action, card), "style": "info", "author": cfg.id, "memory": memory})
}

/// What an app that doesn't know memory cards shows.
fn summary(action: &Action, card: &Card) -> String {
    let previous = card.previous.as_deref().unwrap_or_default();
    let what = match action {
        Action::Remember { text, .. } | Action::Revise { text, .. } => text.as_str(),
        Action::Archive { .. } => previous,
    };
    match (card.status, action) {
        (Status::Pending, Action::Remember { .. }) => format!("Wants to remember: {what}"),
        (Status::Pending, Action::Revise { .. }) => format!("Wants to update memory: {previous} → {what}"),
        (Status::Pending, Action::Archive { .. }) => format!("Wants to archive from memory: {what}"),
        (Status::Done | Status::Accepted, Action::Remember { .. }) => format!("Remembered: {what}"),
        (Status::Done | Status::Accepted, Action::Revise { .. }) => format!("Updated memory: {what}"),
        (Status::Done | Status::Accepted, Action::Archive { .. }) => format!("Archived from memory: {what}"),
        (Status::Declined, _) => format!("Declined: {what}"),
        (Status::Undone, _) => format!("Undone: {what}"),
        (Status::Failed, _) => format!("Couldn't save to memory: {what}"),
    }
}

fn open(hub: &Hub, notice_id: &str) -> Result<(crate::store::Entry, BotConfig, Action, Card)> {
    let notice = hub.store.entry(notice_id).ok_or_else(|| anyhow!("unknown card"))?;
    let memory = &notice.data["memory"];
    let action: Action = serde_json::from_value(memory.clone()).map_err(|_| anyhow!("not a memory card"))?;
    let card: Card = serde_json::from_value(memory.clone())?;
    let bot = notice.data["author"].as_str().unwrap_or(&notice.bot_id);
    let cfg = hub.store.bot(bot)?.filter(|b| !b.deleted).ok_or_else(|| anyhow!("unknown bot"))?.config;
    Ok((notice, cfg, action, card))
}
