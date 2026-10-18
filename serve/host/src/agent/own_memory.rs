//! The harnesses' own memory, turned off where Codync's is the bot's only one: a bot in its own workspace, and
//! Codync's background jobs ([design](../../../docs/design/bot-memory.md#instructions-in-every-harness)).
//! Claude Code also gets its settings through `_meta` (see `agent::bot`).

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::Path;

/// For the agent's process. A harness ignores the variables meant for the others.
pub const ENV: &[(&str, &str)] = &[("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"), ("CODEBUDDY_DISABLE_AUTO_MEMORY", "1")];

/// Appended to the harness's ACP command.
pub fn args(backend: &str) -> &'static str {
    match backend {
        // Copilot Memory writes through these two tools.
        "copilot" => " --excluded-tools=store_memory,vote_memory",
        _ => "",
    }
}

/// Turns the harness's own memory off for one launch in `workspace`: its environment, its command, and the
/// settings it reads from the folder.
pub async fn turn_off(backend: &str, workspace: &str, env: &mut Vec<(String, String)>, commands: &mut [String]) {
    env.extend(ENV.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    for command in commands {
        command.push_str(args(backend));
    }
    let (backend, workspace) = (backend.to_owned(), workspace.to_owned());
    match tokio::task::spawn_blocking(move || prepare_workspace(&backend, Path::new(&workspace))).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(error = format!("{error:#}"), "couldn't turn off the harness's own memory"),
        Err(error) => tracing::warn!(%error, "couldn't turn off the harness's own memory"),
    }
}

/// Settings a harness reads from the workspace folder itself.
fn prepare_workspace(backend: &str, workspace: &Path) -> Result<()> {
    match backend {
        "qwen" => merge(
            &workspace.join(".qwen/settings.json"),
            &json!({"memory": {"enableManagedAutoMemory": false, "enableManagedAutoDream": false}}),
        ),
        _ => Ok(()),
    }
}

/// Sets `settings`' keys in the JSON file at `path`, keeping the rest of it.
fn merge(path: &Path, settings: &Value) -> Result<()> {
    let mut current = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("reading {}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let before = current.clone();
    overlay(&mut current, settings);
    if current == before {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&current)?).with_context(|| format!("writing {}", path.display()))
}

fn overlay(target: &mut Value, settings: &Value) {
    match (target, settings) {
        (Value::Object(target), Value::Object(settings)) => {
            for (key, value) in settings {
                overlay(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, value) => *target = value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_settings_keep_what_the_user_set() {
        let dir = std::env::temp_dir().join(format!("codync-own-memory-{}", uuid::Uuid::new_v4()));
        let file = dir.join(".qwen/settings.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"model": {"name": "qwen3"}, "memory": {"other": 1}}"#).unwrap();
        prepare_workspace("qwen", &dir).unwrap();
        let settings: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(settings["model"]["name"], "qwen3");
        assert_eq!(
            settings["memory"],
            json!({"other": 1, "enableManagedAutoMemory": false, "enableManagedAutoDream": false})
        );
        prepare_workspace("codex", &dir.join("none")).unwrap();
        assert!(!dir.join("none").exists(), "nothing for other harnesses");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
