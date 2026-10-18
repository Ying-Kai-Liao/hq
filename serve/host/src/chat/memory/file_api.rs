//! The apps' methods for long-form memory files: list, read with versions, save, delete and restore. The user's
//! own edits skip the checks a bot's pass, and every write is compare-and-swap on the content the app loaded.

use super::files::{self, Writer};
use crate::hub::Hub;
use crate::store::BotConfig;
use anyhow::{Result, anyhow, bail};
use codync_mem::files::{self as mf, Author, Cause};
use serde_json::{Value, json};

/// Versions the detail view lists.
const VERSIONS_SHOWN: usize = 20;

/// Both layers' files for the memory screen, after a scan.
pub fn listing(hub: &Hub, cfg: &BotConfig) -> Result<Value> {
    files::scan(hub, cfg);
    let layer = |bot: Option<&str>| -> Result<Value> {
        let list = hub.store.memory_read(|c| mf::layer(c, bot))?;
        Ok(json!({"files": list, "folder": files::folder(bot).display().to_string()}))
    };
    Ok(json!({
        "yours": layer(None)?,
        "bot": layer(Some(&cfg.id))?,
        "cap": mf::FILE_CAP,
        "folderCap": mf::FOLDER_CAP,
    }))
}

pub fn call(hub: &Hub, cfg: &BotConfig, method: &str, b: &Value) -> Result<Value> {
    let name = b["file"].as_str().ok_or_else(|| anyhow!("file required"))?;
    let layer = (b["shared"] != true).then_some(cfg.id.as_str());
    let base = b["base"].as_str().filter(|h| !h.is_empty());
    let user = |cause| Writer { author: Author::User, bot: None, cause };
    let version = match method {
        "memoryFile" => return detail(hub, cfg, layer, name),
        "saveMemoryFile" => {
            let content = b["content"].as_str().ok_or_else(|| anyhow!("content required"))?;
            if content.trim().is_empty() {
                bail!("A memory file can't be empty; delete it instead.");
            }
            files::write(hub, layer, name, Some(content), base, user(Cause::Edit))?
        }
        "deleteMemoryFile" => files::write(hub, layer, name, None, base, user(Cause::Delete))?,
        "restoreMemoryFile" => {
            let id = b["version"].as_i64().ok_or_else(|| anyhow!("version required"))?;
            let old = hub.store.memory_read(|c| mf::version(c, id))?;
            let old = old
                .filter(|v| v.name == name && v.bot.as_deref() == layer)
                .ok_or_else(|| anyhow!("unknown version"))?;
            files::write(hub, layer, name, old.content.as_deref(), base, user(Cause::Restore))?
        }
        _ => bail!("unknown method: {method}"),
    };
    Ok(json!({"version": version}))
}

/// A file as it is on disk now, its hash for the next save, and its recent versions.
fn detail(hub: &Hub, cfg: &BotConfig, layer: Option<&str>, name: &str) -> Result<Value> {
    files::scan(hub, cfg);
    let content = files::read(layer, name)?;
    let versions = hub.store.memory_read(|c| mf::versions(c, layer, name, VERSIONS_SHOWN))?;
    Ok(json!({
        "file": name,
        "shared": layer.is_none(),
        "content": content,
        "hash": content.as_deref().map(mf::hash),
        "path": files::folder(layer).join(name).display().to_string(),
        "versions": versions,
    }))
}
