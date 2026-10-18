//! The bot's long-form memory tools, for agents that can't reach the folders with their own file tools.

use super::files::{self, Writer};
use crate::hub::Hub;
use crate::store::BotConfig;
use anyhow::{Result, anyhow, bail};
use codync_mem::files::{self as mf, Author, Cause};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn definitions() -> [Value; 2] {
    let file = json!({"type": "string", "description": "The file name, like people.md."});
    let shared = json!({"type": "boolean", "description": "True for a file in the memory all the user's bots share."});
    [
        json!({
            "name": "read_memory",
            "description": "Read one of your long-form memory files, or without a file, list them with their descriptions.",
            "inputSchema": {"type": "object", "properties": {"file": file, "shared": shared}},
            "annotations": {"readOnlyHint": true},
        }),
        json!({
            "name": "edit_memory",
            "description": "Create, change or delete one of your long-form memory files: notes on one topic about the user, too detailed for a memory entry. Give old and new to replace text that appears once, content to write the whole file, or delete. A file starts with frontmatter whose description: line says when to read it, and holds at most 2,000 tokens. The user sees every version in the bot's memory settings and can bring one back there.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": file,
                    "shared": shared,
                    "old": {"type": "string", "description": "Text the file has exactly once."},
                    "new": {"type": "string", "description": "What replaces old."},
                    "content": {"type": "string", "description": "The whole file, frontmatter first."},
                    "delete": {"type": "boolean"},
                },
                "required": ["file"],
            },
        }),
    ]
}

pub async fn call(hub: &Arc<Hub>, cfg: &BotConfig, name: &str, args: &Value) -> Result<Value> {
    let (hub, cfg, name, args) = (hub.clone(), cfg.clone(), name.to_owned(), args.clone());
    tokio::task::spawn_blocking(move || match name.as_str() {
        "read_memory" => read(&hub, &cfg, &args),
        "edit_memory" => edit(&hub, &cfg, &args),
        _ => bail!("unknown memory tool: {name}"),
    })
    .await?
}

fn layer(cfg: &BotConfig, args: &Value) -> Result<Option<String>> {
    if args["shared"] != true {
        return Ok(Some(cfg.id.clone()));
    }
    if !super::shared(cfg) {
        bail!("This bot doesn't use the shared memory.");
    }
    Ok(None)
}

fn read(hub: &Hub, cfg: &BotConfig, args: &Value) -> Result<Value> {
    files::scan(hub, cfg);
    let Some(name) = args["file"].as_str() else {
        let files: Vec<Value> = files::layers(cfg)
            .iter()
            .flat_map(|layer| {
                hub.store.memory_read(|c| mf::layer(c, layer.as_deref())).unwrap_or_default().into_iter().filter(|f| !f.deleted)
            })
            .map(|f| json!({"file": f.name, "shared": f.bot.is_none(), "description": f.description, "tokens": f.tokens}))
            .collect();
        return Ok(json!({"files": files}));
    };
    let layer = layer(cfg, args)?;
    let content = files::read(layer.as_deref(), name)?.ok_or_else(|| anyhow!("There's no memory file {name}."))?;
    Ok(json!({"file": name, "content": content}))
}

fn edit(hub: &Hub, cfg: &BotConfig, args: &Value) -> Result<Value> {
    let name = args["file"].as_str().ok_or_else(|| anyhow!("file required"))?;
    let layer = layer(cfg, args)?;
    files::scan(hub, cfg);
    let before = files::read(layer.as_deref(), name)?;
    let after = if args["delete"] == true {
        if before.is_none() {
            bail!("There's no memory file {name}.");
        }
        None
    } else if let Some(content) = args["content"].as_str() {
        Some(content.to_owned())
    } else {
        let (old, new) = (args["old"].as_str().unwrap_or_default(), args["new"].as_str().unwrap_or_default());
        let current =
            before.as_deref().ok_or_else(|| anyhow!("There's no memory file {name}; give content to create it."))?;
        match current.matches(old).count() {
            _ if old.is_empty() => bail!("Give old and new, content, or delete."),
            1 => Some(current.replacen(old, new, 1)),
            0 => bail!("old isn't in {name}. Read it again."),
            _ => bail!("old appears more than once in {name}. Give more of the text around it."),
        }
    };
    if let Some(content) = &after {
        mf::check(content)?;
    }
    let expected = before.as_deref().map(mf::hash);
    let cause = if after.is_some() { Cause::Edit } else { Cause::Delete };
    let writer = Writer { author: Author::Bot, bot: Some(cfg), cause };
    files::write(hub, layer.as_deref(), name, after.as_deref(), expected.as_deref(), writer)?;
    Ok(json!({"status": "saved", "file": name}))
}
