//! Long-form memory on disk ([design](../../../../docs/design/bot-memory.md#long-form-memory)): the folders, the
//! scan that turns what changed in them into versions, and the host's own compare-and-swap writes. The rules
//! (names, checks, versions, the index) are `codync_mem::files`.

use crate::LockExt;
use crate::hub::Hub;
use crate::store::{BotConfig, Store};
use anyhow::{Context, Result, anyhow, bail};
use codync_mem::files::{self as mf, Author, Cause, Change, Version};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

/// A file changed more recently than this may still be mid-write: the next scan takes it.
const SETTLE_MS: i64 = 2_000;

/// A layer's folder: the shared one (`None`), or a bot's own.
pub fn folder(bot: Option<&str>) -> PathBuf {
    let data = crate::service::data_dir();
    match bot {
        Some(id) => data.join("bots").join(id).join("bot-memory"),
        None => data.join("shared-memory"),
    }
}

/// The layers a bot sees: its own, and the shared one when it uses it.
pub fn layers(cfg: &BotConfig) -> Vec<Option<String>> {
    let mut layers = vec![Some(cfg.id.clone())];
    if super::shared(cfg) {
        layers.push(None);
    }
    layers
}

/// The folders a bot sees, created so an agent can be given them.
pub fn folders(cfg: &BotConfig) -> Vec<PathBuf> {
    layers(cfg)
        .iter()
        .map(|layer| {
            let dir = folder(layer.as_deref());
            if let Err(error) = std::fs::create_dir_all(&dir) {
                tracing::warn!(dir = %dir.display(), error = %error, "couldn't create a memory folder");
            }
            dir
        })
        .collect()
}

/// The index of the files a bot sees, for its opening.
pub fn index(store: &Store, cfg: &BotConfig) -> String {
    match store.memory_read(|c| mf::index(c, &cfg.id, super::shared(cfg))) {
        Ok(index) => index.render(|bot| folder(bot).display().to_string()),
        Err(error) => {
            tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't read the memory files");
            String::new()
        }
    }
}

/// The bot's tool call that last touched a memory file, so the next scan credits the change to it.
#[derive(Serialize, Deserialize)]
struct Touch {
    bot: String,
}

/// Notes the memory files a tool call names (its `locations` and diffs), so the scan knows which bot changed them.
/// Only calls that change files count: a read left behind would credit the next outside edit to the bot.
pub fn touched(store: &Store, cfg: &BotConfig, tool: &serde_json::Value) {
    let changes = matches!(tool["toolKind"].as_str(), Some("edit" | "delete" | "move"))
        || tool["diffs"].as_array().is_some_and(|d| !d.is_empty());
    if !changes {
        return;
    }
    let paths = tool["locations"]
        .as_array()
        .into_iter()
        .chain(tool["diffs"].as_array())
        .flatten()
        .filter_map(|item| item["path"].as_str());
    let folders: Vec<PathBuf> = layers(cfg).iter().map(|layer| folder(layer.as_deref())).collect();
    for path in paths {
        let path = Path::new(path);
        if path.parent().is_some_and(|dir| folders.iter().any(|f| f == dir)) {
            let touch = Touch { bot: cfg.id.clone() };
            let value = serde_json::to_string(&touch).expect("a touch is plain data");
            if let Err(error) = store.kv_set(&touch_key(path), &value) {
                tracing::warn!(error = format!("{error:#}"), "couldn't note a memory file edit");
            }
        }
    }
}

fn touch_key(path: &Path) -> String {
    format!("memory.touched.{}", path.display())
}

/// One scan at a time, so two can't record the same change.
// ponytail: one lock for every folder; per-folder locks if scans ever queue behind each other.
static SCANNING: Mutex<()> = Mutex::new(());

/// Records what changed in the folders a bot sees since the last scan. Returns whether a file was too fresh to
/// take yet.
pub fn scan(hub: &Hub, cfg: &BotConfig) -> bool {
    let _one = SCANNING.locked();
    let mut deferred = false;
    for layer in layers(cfg) {
        match scan_layer(hub, layer.as_deref()) {
            Ok(fresh) => deferred |= fresh,
            Err(error) => tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't scan the memory files"),
        }
    }
    deferred
}

/// At the end of a turn: the bot's edits usually come right before its reply, so a file still settling is taken
/// once it has.
pub fn scan_after_turn(hub: Arc<Hub>, cfg: BotConfig) {
    tokio::spawn(async move {
        let (h, c) = (hub.clone(), cfg.clone());
        if tokio::task::spawn_blocking(move || scan(&h, &c)).await.unwrap_or(false) {
            tokio::time::sleep(std::time::Duration::from_millis(u64::try_from(SETTLE_MS).unwrap_or(2_000) + 100)).await;
            let _ = tokio::task::spawn_blocking(move || scan(&hub, &cfg)).await;
        }
    });
}

/// What is on disk for one file.
struct OnDisk {
    content: String,
    mtime: i64,
    size: u64,
}

/// Scans one folder; true when a file was too fresh to take yet.
fn scan_layer(hub: &Hub, layer: Option<&str>) -> Result<bool> {
    let dir = folder(layer);
    // A folder that went missing is not every file deleted.
    let Ok(listing) = std::fs::read_dir(&dir) else { return Ok(false) };
    let mut deferred = false;
    let recorded: HashMap<String, mf::File> =
        hub.store.memory_read(|c| mf::layer(c, layer))?.into_iter().map(|f| (f.name.clone(), f)).collect();
    let now = crate::store::now_ms();
    let mut present = HashSet::new();
    for item in listing.flatten() {
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        let Some((mtime, size)) = regular(&item.path(), &name) else { continue };
        present.insert(name.clone());
        let known = recorded.get(&name);
        if known.is_some_and(|f| !f.deleted && f.mtime == mtime && f.size == size) {
            continue;
        }
        if now - mtime < SETTLE_MS {
            deferred = true;
            continue;
        }
        let content = match std::fs::read_to_string(item.path()) {
            Ok(content) => content,
            Err(error) => {
                tracing::warn!(file = %name, error = %error, "couldn't read a memory file");
                continue;
            }
        };
        if known.is_some_and(|f| f.hash == mf::hash(&content)) {
            hub.store.memory_write(|c, _, _| mf::observed(c, layer, &name, mtime, size))?;
            continue;
        }
        found(hub, layer, &name, Some(&OnDisk { content, mtime, size }))?;
    }
    for name in recorded.values().filter(|f| !f.deleted && !present.contains(&f.name)).map(|f| &f.name) {
        found(hub, layer, name, None)?;
    }
    Ok(deferred)
}

/// A regular `.md` file with a valid name: its modification time and size. Links, hidden files and folders are
/// left alone, so nothing can make the host read, journal or restore another file.
fn regular(path: &Path, name: &str) -> Option<(i64, u64)> {
    if !mf::valid_name(name) {
        return None;
    }
    let meta = std::fs::symlink_metadata(path).ok().filter(std::fs::Metadata::is_file)?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
    Some((i64::try_from(mtime).ok()?, meta.len()))
}

/// A change the scan found: from a bot's tool call, checked and shown in its chat; otherwise just recorded.
fn found(hub: &Hub, layer: Option<&str>, name: &str, after: Option<&OnDisk>) -> Result<()> {
    let path = folder(layer).join(name);
    let touch: Option<Touch> = hub.store.kv_get(&touch_key(&path)).and_then(|v| serde_json::from_str(&v).ok());
    hub.store.kv_delete(&touch_key(&path))?;
    let bot = touch
        .as_ref()
        .and_then(|t| hub.store.bot(&t.bot).ok().flatten())
        .filter(|row| !row.deleted)
        .map(|row| row.config);
    let before = hub.store.memory_read(|c| mf::current(c, layer, name))?;
    let (mtime, size) = after.map_or((0, 0), |a| (a.mtime, a.size));
    let content = after.map(|a| a.content.as_str());
    let Some(cfg) = bot else {
        let change = Change {
            bot: layer,
            name,
            content,
            author: Author::Computer,
            author_bot: None,
            cause: if content.is_some() { Cause::Edit } else { Cause::Delete },
            mtime,
            size,
        };
        hub.store.memory_write(|c, now, rev| mf::record(c, &change, now, rev))?;
        super::changed(hub, layer);
        return Ok(());
    };
    if let Some(content) = content
        && let Err(refusal) = mf::check(content)
    {
        // Put back what was there, as it was recorded.
        put(&path, before.as_deref())?;
        let (mtime, size) = regular(&path, name).unwrap_or_default();
        if before.is_some() {
            hub.store.memory_write(|c, _, _| mf::observed(c, layer, name, mtime, size))?;
        }
        tracing::info!(bot = %cfg.id, file = name, reason = refusal.message(), "put back a bot's memory note change");
        return Ok(());
    }
    let change = Change {
        bot: layer,
        name,
        content,
        author: Author::Bot,
        author_bot: Some(&cfg.id),
        cause: if content.is_some() { Cause::Edit } else { Cause::Delete },
        mtime,
        size,
    };
    record_bot_change(hub, &cfg, layer, &change)?;
    Ok(())
}

/// Records a bot's change and tells the other sessions; the one it was made in already knows.
fn record_bot_change(hub: &Hub, cfg: &BotConfig, layer: Option<&str>, change: &Change<'_>) -> Result<Version> {
    let heard = super::current_revision(&hub.store, &cfg.id);
    let version = hub.store.memory_write(|c, now, rev| mf::record(c, change, now, rev))?;
    super::changed(hub, layer);
    if let Some(session) = hub.runtime(&cfg.id).session
        && let Err(error) = super::heard_own_write(&hub.store, &cfg.id, &session, &heard)
    {
        tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't record the bot's own edit");
    }
    Ok(version)
}

/// The file's content on disk now, `None` when there is none. Refuses names the folders don't hold.
pub fn read(layer: Option<&str>, name: &str) -> Result<Option<String>> {
    if !mf::valid_name(name) {
        bail!("Memory file names are lowercase letters, digits and dashes, ending in .md (like people.md).");
    }
    let path = folder(layer).join(name);
    if regular(&path, name).is_none() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).with_context(|| format!("reading {name}"))
}

/// Who a host write is for.
#[derive(Clone, Copy)]
pub struct Writer<'a> {
    pub author: Author,
    pub bot: Option<&'a BotConfig>,
    pub cause: Cause,
}

/// Writes a file the way every host writer does: only over the content whose hash is `expected` (`None`: no file
/// yet), through a temporary file in the same folder renamed over it, or by deleting it (`content` `None`). A file
/// that changed meanwhile isn't overwritten: its change is recorded and the write fails.
pub fn write(
    hub: &Hub,
    layer: Option<&str>,
    name: &str,
    content: Option<&str>,
    expected: Option<&str>,
    writer: Writer<'_>,
) -> Result<Version> {
    let now = read(layer, name)?;
    if now.as_deref().map(mf::hash).as_deref() != expected {
        // The other change is recorded, so it isn't lost.
        let _one = SCANNING.locked();
        scan_layer(hub, layer)?;
        bail!("{name} changed meanwhile. Read it again and redo the change on top of it.");
    }
    if now.as_deref() == content {
        return hub
            .store
            .memory_read(|c| {
                let file = mf::get(c, layer, name)?.ok_or(codync_mem::store::Error::NotFound)?;
                mf::version(c, file.version)?.ok_or(codync_mem::store::Error::NotFound)
            })
            .context("the file has no recorded version");
    }
    let path = folder(layer).join(name);
    std::fs::create_dir_all(folder(layer)).context("creating the memory folder")?;
    put(&path, content)?;
    let (mtime, size) = regular(&path, name).unwrap_or_default();
    let change = Change {
        bot: layer,
        name,
        content,
        author: writer.author,
        author_bot: writer.bot.map(|cfg| cfg.id.as_str()),
        cause: writer.cause,
        mtime,
        size,
    };
    match writer.bot {
        Some(cfg) if writer.author == Author::Bot => record_bot_change(hub, cfg, layer, &change),
        _ => {
            let version = hub.store.memory_write(|c, now, rev| mf::record(c, &change, now, rev))?;
            super::changed(hub, layer);
            Ok(version)
        }
    }
}

/// Replaces or deletes a file on disk: a temporary sibling renamed over it, so a reader never sees half of it.
fn put(path: &Path, content: Option<&str>) -> Result<()> {
    let Some(content) = content else {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        };
    };
    let dir = path.parent().ok_or_else(|| anyhow!("a memory file has a folder"))?;
    let temp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, content).context("writing the memory file")?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error).context("replacing the memory file");
    }
    Ok(())
}

/// Dreaming's notes: each appended to its file as a list line (a new file gets frontmatter first), and logged with
/// the run. A run whose notes all failed and that changed nothing else is dropped.
pub fn write_notes(hub: &Hub, cfg: &BotConfig, dream: i64, notes: &[codync_mem::dream::Note]) {
    let writer = Writer { author: Author::Dream, bot: Some(cfg), cause: Cause::Dream };
    for note in notes {
        let layer = note.bot.as_deref();
        let line = if note.text.starts_with(['-', '#', '*']) { note.text.clone() } else { format!("- {}", note.text) };
        let written = read(layer, &note.file).and_then(|before| {
            let after = match &before {
                Some(text) => format!("{}\n{line}\n", text.trim_end()),
                None => format!("---\ndescription: {}\n---\n{line}\n", note.description),
            };
            mf::check(&after)?;
            write(hub, layer, &note.file, Some(&after), before.as_deref().map(mf::hash).as_deref(), writer)
        });
        match written {
            Ok(version) => {
                if let Err(error) =
                    hub.store.memory_write(|c, _, _| codync_mem::dream::record_file(c, dream, version.id))
                {
                    tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't log a dream's note");
                }
            }
            Err(error) => {
                tracing::info!(bot = %cfg.id, file = %note.file, error = format!("{error:#}"), "dreaming's note wasn't written");
            }
        }
    }
    if let Err(error) = hub.store.memory_write(|c, _, _| codync_mem::dream::discard_if_empty(c, dream)) {
        tracing::warn!(bot = %cfg.id, error = format!("{error:#}"), "couldn't tidy the dream log");
    }
}

/// Undoing a run puts back the files it appended to, newest note first. A file changed since keeps its change.
pub fn undo_notes(hub: &Hub, dream: &codync_mem::dream::Dream) {
    let writer = Writer { author: Author::User, bot: None, cause: Cause::Undo };
    for change in dream.files.iter().rev() {
        let layer = (!change.shared).then_some(dream.bot.as_str());
        let undone = (|| -> Result<Version> {
            let versions = hub.store.memory_read(|c| mf::versions(c, layer, &change.name, 50))?;
            let at = versions.iter().position(|v| v.id == change.version).ok_or_else(|| anyhow!("version gone"))?;
            let wrote = versions[at].content.as_deref().map(mf::hash);
            let before = versions.get(at + 1).and_then(|v| v.content.as_deref());
            write(hub, layer, &change.name, before, wrote.as_deref(), writer)
        })();
        if let Err(error) = undone {
            tracing::info!(file = %change.name, error = format!("{error:#}"), "a dream's note stays: the file changed since");
        }
    }
}

/// "Forget everything" for a layer: its files on disk, their versions and records.
pub fn forget_layer(hub: &Hub, layer: Option<&str>) -> Result<()> {
    hub.store.memory_write(|c, _, _| mf::forget_layer(c, layer))?;
    let dir = folder(layer);
    for item in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if let Some(name) = item.file_name().to_str()
            && regular(&item.path(), name).is_some()
        {
            std::fs::remove_file(item.path()).with_context(|| format!("deleting {name}"))?;
        }
    }
    Ok(())
}

/// A deleted bot's folder.
pub fn remove_bot(id: &str) {
    if let Err(error) = std::fs::remove_dir_all(folder(Some(id)))
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(error = %error, "couldn't remove a deleted bot's memory files");
    }
}
