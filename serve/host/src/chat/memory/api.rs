//! The apps' memory methods: the two layers, the user's own edits, the dream log, and the chat cards.

use super::{Change, notices};
use crate::hub::Hub;
use crate::store::BotConfig;
use anyhow::{Result, anyhow, bail};
use codync_mem::store::{self as mem, Entry, Error, New, State, Writer};
use serde_json::{Value, json};
use std::sync::Arc;

/// Dream runs the memory screen lists.
const DREAMS_SHOWN: usize = 20;
/// The most of a project's `MEMORY.md` the screen shows.
const PROJECT_MEMORY_BYTES: u64 = 64 * 1024;

pub async fn call(hub: &Arc<Hub>, method: &str, b: &Value) -> Result<Value> {
    let hub = hub.clone();
    let method = method.to_owned();
    let b = b.clone();
    tokio::task::spawn_blocking(move || dispatch(&hub, &method, &b)).await?
}

fn dispatch(hub: &Hub, method: &str, b: &Value) -> Result<Value> {
    match method {
        "answerMemory" => return notices::answer(hub, str_arg(b, "entryId")?, b["accept"] == true),
        "undoMemory" => return notices::undo(hub, str_arg(b, "entryId")?),
        _ => {}
    }
    let cfg = bot(hub, str_arg(b, "botId")?)?;
    let id = || b["id"].as_i64().ok_or_else(|| anyhow!("id required"));
    match method {
        "memory" => view(hub, &cfg),
        "saveMemory" => {
            let text = str_arg(b, "text")?;
            let entry = if let Some(id) = b["id"].as_i64() {
                edit(hub, &cfg, id, |c, now, rev| mem::revise(c, Writer::User, id, text, now, rev))?
            } else {
                let layer = (b["shared"] != true).then_some(cfg.id.as_str());
                let new = New { bot: layer, text, room: None, evidence: &[] };
                let entry = hub.store.memory_write(|c, now, rev| mem::add(c, Writer::User, new, now, rev))?;
                super::changed(hub, entry.bot.as_deref(), Change::User);
                entry
            };
            Ok(json!({"entry": entry}))
        }
        "pinMemory" => {
            let (id, pinned) = (id()?, b["pinned"] == true);
            edit(hub, &cfg, id, |c, now, rev| mem::pin(c, id, pinned, now, rev))?;
            Ok(json!({}))
        }
        "archiveMemory" => {
            let id = id()?;
            if b["archived"] == false {
                edit(hub, &cfg, id, |c, now, rev| mem::activate(c, id, now, rev))?;
            } else {
                edit(hub, &cfg, id, |c, now, rev| mem::archive(c, Writer::User, id, None, now, rev))?;
            }
            Ok(json!({}))
        }
        "forgetMemory" => {
            let id = id()?;
            edit(hub, &cfg, id, |c, _, _| mem::forget(c, id))?;
            Ok(json!({}))
        }
        "clearMemory" => {
            let layer = (b["shared"] != true).then_some(cfg.id.as_str());
            hub.store.memory_write(|c, _, _| mem::forget_layer(c, layer))?;
            super::changed(hub, layer, Change::User);
            Ok(json!({}))
        }
        "undoDream" => {
            let id = id()?;
            let dream = hub.store.memory_read(|c| codync_mem::dream::get(c, id))?;
            if dream.is_none_or(|d| d.bot != cfg.id) {
                bail!("unknown dream");
            }
            hub.store.memory_write(|c, now, rev| codync_mem::dream::undo(c, id, now, rev))?;
            // A run may have written to either layer.
            super::changed(hub, None, Change::User);
            Ok(json!({}))
        }
        _ => bail!("unknown method: {method}"),
    }
}

/// Changes one entry the bot can see, then tells the bots that see it.
fn edit(
    hub: &Hub,
    cfg: &BotConfig,
    id: i64,
    change: impl FnOnce(&rusqlite::Connection, i64, i64) -> mem::Result<Entry>,
) -> Result<Entry> {
    let bot = cfg.id.clone();
    let entry = hub.store.memory_write(|c, now, rev| {
        let entry = mem::get(c, id)?.ok_or(Error::NotFound)?;
        if entry.bot.as_deref().is_some_and(|owner| owner != bot) {
            return Err(Error::NotFound);
        }
        change(c, now, rev)
    })?;
    super::changed(hub, entry.bot.as_deref(), Change::User);
    Ok(entry)
}

fn view(hub: &Hub, cfg: &BotConfig) -> Result<Value> {
    let bot = cfg.id.as_str();
    let (yours, own, dreams) = hub.store.memory_read(|c| {
        Ok((mem::layer(c, None)?, mem::layer(c, Some(bot))?, codync_mem::dream::recent(c, bot, DREAMS_SHOWN)?))
    })?;
    let layer = |entries: Vec<Entry>, layer: Option<&str>| {
        let used: usize =
            entries.iter().filter(|e| e.state == State::Active).map(|e| codync_mem::tokens::estimate(&e.text)).sum();
        json!({"entries": entries, "used": used, "cap": mem::cap(layer)})
    };
    Ok(json!({
        "shared": super::shared(cfg),
        "yours": layer(yours, None),
        "bot": layer(own, Some(bot)),
        "dreams": dreams,
        "projectMemory": project_memory(cfg),
        "memoryRev": hub.store.memory_rev(),
    }))
}

/// Claude Code's own memory of a project bot's folder (`~/.claude/projects/<folder>/memory/MEMORY.md`), shown
/// read-only so nothing a bot remembers is out of the user's sight.
fn project_memory(cfg: &BotConfig) -> Value {
    if crate::agent::workspace::is_managed(cfg) || cfg.backend != "claude" {
        return Value::Null;
    }
    let folder: String = cfg.cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let Some(path) = dirs::home_dir().map(|home| home.join(".claude/projects").join(folder).join("memory/MEMORY.md"))
    else {
        return Value::Null;
    };
    let read = std::fs::File::open(&path).and_then(|file| {
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(file, PROJECT_MEMORY_BYTES), &mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    });
    read.map_or(Value::Null, |text| json!({"path": path.to_string_lossy(), "text": text}))
}

fn bot(hub: &Hub, id: &str) -> Result<BotConfig> {
    let cfg = hub.store.bot(id)?.filter(|b| !b.deleted).ok_or_else(|| anyhow!("unknown bot"))?.config;
    if cfg.is_group() {
        bail!("a group has no memory of its own");
    }
    Ok(cfg)
}

fn str_arg<'a>(b: &'a Value, k: &str) -> Result<&'a str> {
    b[k].as_str().ok_or_else(|| anyhow!("{k} required"))
}
