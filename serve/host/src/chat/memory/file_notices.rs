//! A bot's changes to its memory files don't show in the chat: the memory settings keep every version. Lines and
//! cards that older hosts put in the chat ("Updated people.md" with an undo, a change to approve) still answer and
//! undo for the apps that show them; their `memoryFile` field holds the change.

use super::files::{self, Writer};
use crate::hub::Hub;
use crate::store::BotConfig;
use anyhow::{Result, anyhow, bail};
use codync_mem::files::{self as mf, Author, Cause};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Status {
    Done,
    Pending,
    Accepted,
    Declined,
    Undone,
    Restored,
    Failed,
}

/// What the `memoryFile` field of the chat line records.
// Each flag is one fact the apps show about the change, independent of the others.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Card {
    file: String,
    shared: bool,
    status: Status,
    /// `- ` removed and `+ ` added lines.
    diff: String,
    #[serde(default)]
    created: bool,
    #[serde(default)]
    deleted: bool,
    /// The change removes more than a quarter of the file.
    #[serde(default)]
    big: bool,
    /// The version written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<i64>,
    /// The version before, which undo brings back; `None` with a version: undo deletes the new file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<i64>,
    /// Pending: the content it would write (`None` with `deleted`), over the content with this hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// The live version before `version`, which undo brings back.
fn previous(hub: &Hub, layer: Option<&str>, name: &str, version: i64) -> Option<i64> {
    let versions = hub.store.memory_read(|c| mf::versions(c, layer, name, 50)).ok()?;
    let at = versions.iter().position(|v| v.id == version)?;
    versions.get(at + 1).filter(|v| v.content.is_some()).map(|v| v.id)
}

/// Whether a chat line is a memory file's.
pub fn is_file_card(data: &Value) -> bool {
    data["memoryFile"].is_object()
}

/// The user approved or declined a bot's change.
pub fn answer(hub: &Hub, notice_id: &str, accept: bool) -> Result<Value> {
    let (notice, cfg, mut card) = open(hub, notice_id)?;
    if card.status != Status::Pending {
        bail!("This card was already answered.");
    }
    let layer = layer(&cfg, &card)?;
    if accept {
        let cause = if card.deleted { Cause::Delete } else { Cause::Edit };
        let writer = Writer { author: Author::Bot, bot: Some(&cfg), cause };
        match files::write(hub, layer.as_deref(), &card.file, card.content.as_deref(), card.base.as_deref(), writer) {
            Ok(version) => {
                card.status = Status::Accepted;
                card.version = Some(version.id);
                card.previous = previous(hub, layer.as_deref(), &card.file, version.id);
            }
            Err(error) => {
                card.status = Status::Failed;
                card.reason = Some(format!("{error:#}"));
            }
        }
    } else {
        card.status = Status::Declined;
    }
    card.content = None;
    Ok(update(hub, &notice, &cfg, &card))
}

/// The user took back a bot's change: the version before it comes back (or a new file goes).
pub fn undo(hub: &Hub, notice_id: &str) -> Result<Value> {
    let (notice, cfg, mut card) = open(hub, notice_id)?;
    let version = card.version.filter(|_| matches!(card.status, Status::Done | Status::Accepted));
    let version = version.ok_or_else(|| anyhow!("There's nothing to undo."))?;
    let layer = layer(&cfg, &card)?;
    let content = |id: i64| -> Result<Option<String>> {
        Ok(hub.store.memory_read(|c| mf::version(c, id))?.ok_or_else(|| anyhow!("That version is gone."))?.content)
    };
    let expected = content(version)?.as_deref().map(mf::hash);
    let restore = card.previous.map(content).transpose()?.flatten();
    let writer = Writer { author: Author::User, bot: None, cause: Cause::Undo };
    files::write(hub, layer.as_deref(), &card.file, restore.as_deref(), expected.as_deref(), writer)
        .map_err(|_| anyhow!("{} changed since. Open it in memory to bring back an earlier version.", card.file))?;
    card.status = Status::Undone;
    Ok(update(hub, &notice, &cfg, &card))
}

fn layer(cfg: &BotConfig, card: &Card) -> Result<Option<String>> {
    if card.shared && !super::shared(cfg) {
        bail!("This bot no longer uses the shared memory.");
    }
    Ok((!card.shared).then(|| cfg.id.clone()))
}

fn open(hub: &Hub, notice_id: &str) -> Result<(crate::store::Entry, BotConfig, Card)> {
    let notice = hub.store.entry(notice_id).ok_or_else(|| anyhow!("unknown card"))?;
    let card: Card =
        serde_json::from_value(notice.data["memoryFile"].clone()).map_err(|_| anyhow!("not a memory file card"))?;
    let bot = notice.data["author"].as_str().unwrap_or(&notice.bot_id);
    let cfg = hub.store.bot(bot)?.filter(|b| !b.deleted).ok_or_else(|| anyhow!("unknown bot"))?.config;
    Ok((notice, cfg, card))
}

fn update(hub: &Hub, notice: &crate::store::Entry, cfg: &BotConfig, card: &Card) -> Value {
    let mut data = notice.data.clone();
    let fresh = self::data(cfg, card);
    data["text"] = fresh["text"].clone();
    data["memoryFile"] = fresh["memoryFile"].clone();
    hub.set_entry(&notice.id, &data).map_or(Value::Null, |e| json!({"entry": e}))
}

fn data(cfg: &BotConfig, card: &Card) -> Value {
    let memory = serde_json::to_value(card).expect("a card is plain data");
    json!({"text": summary(card), "style": "info", "author": cfg.id, "memoryFile": memory})
}

/// What an app that doesn't know memory file cards shows.
fn summary(card: &Card) -> String {
    let file = &card.file;
    let verb = if card.deleted {
        "Deleted"
    } else if card.created {
        "Created"
    } else {
        "Updated"
    };
    match card.status {
        Status::Done | Status::Accepted => format!("{verb} {file}"),
        Status::Pending => format!("Wants to {} {file}", verb.to_lowercase().trim_end_matches('d')),
        Status::Declined => format!("Declined: {file}"),
        Status::Undone => format!("Undone: {file}"),
        Status::Restored => format!("Put back {file}: {}", card.reason.as_deref().unwrap_or_default()),
        Status::Failed => format!("Couldn't change {file}: {}", card.reason.as_deref().unwrap_or_default()),
    }
}
