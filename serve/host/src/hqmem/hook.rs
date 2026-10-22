//! The Claude Code hooks on Write, Edit and MultiEdit: `pre` checks a memory write and blocks it with the reason,
//! `post` records it as a version. Anything that isn't a memory file returns at once.

use super::{Layout, Who, guard, open, read, record, sync};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// What the hook tells Claude Code: JSON on stdout (a `deny` decision blocks the tool call and shows its reason to the
/// agent) and a message on stderr. The exit code is always 0: Claude Code blocks on exit 2, which is also what a
/// usage error from an older binary exits with, so only the JSON decision may block.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    #[cfg(test)]
    pub fn blocked(&self) -> bool {
        self.stdout.contains("\"permissionDecision\":\"deny\"")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Phase {
    Pre,
    Post,
}

/// Runs one hook call on the JSON Claude Code gave on stdin. Memory trouble (no database, a locked file) never blocks
/// a write: the hook reports it and lets the tool run, because only a refusal is a reason to stop one.
pub fn run(phase: Phase, input: &str, layout: &Layout, agent: &str, dream: bool) -> Outcome {
    let Ok(event) = serde_json::from_str::<Value>(input) else { return Outcome::default() };
    let tool = event["tool_name"].as_str().unwrap_or_default();
    if !matches!(tool, "Write" | "Edit" | "MultiEdit") {
        return Outcome::default();
    }
    let Some(file) = event["tool_input"]["file_path"].as_str() else { return Outcome::default() };
    let cwd = event["cwd"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let Some(target) = layout.locate(Path::new(file), &cwd) else { return Outcome::default() };
    let who = if dream { Who::Dream(agent) } else { Who::Agent(agent) };
    let conn = match open(layout) {
        Ok(conn) => conn,
        Err(e) => {
            let stderr = format!("kith memory: history unavailable ({e:#}); the write is not checked");
            return Outcome { stderr, ..Outcome::default() };
        }
    };
    match phase {
        Phase::Pre => {
            // Whatever changed the file since its last version (a Bash command, an editor) is recorded first, so
            // undoing this write can go back to the file as it is now.
            if let Err(e) = sync(&conn, &target) {
                eprintln!("kith memory: {e:#}");
            }
            let old = read(&target.path);
            let Some(new) = proposed(tool, &event["tool_input"], old.as_deref()) else { return Outcome::default() };
            match guard(Some(&conn), Some(&target), who, old.as_deref(), &new) {
                Err(refusal) => Outcome {
                    stdout: json!({"hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": format!(
                            "Memory write refused for {}: {} Change the text and write again.",
                            target.label(),
                            refusal.message()
                        ),
                    }})
                    .to_string(),
                    ..Outcome::default()
                },
                Ok(warnings) if warnings.is_empty() => Outcome::default(),
                Ok(warnings) => Outcome {
                    stdout: json!({"hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "additionalContext": warnings.join(" "),
                    }})
                    .to_string(),
                    ..Outcome::default()
                },
            }
        }
        Phase::Post => match record(&conn, &target, who) {
            Ok(_) => Outcome::default(),
            Err(e) => {
                let stderr = format!("kith memory: could not record {}: {e:#}", target.label());
                Outcome { stderr, ..Outcome::default() }
            }
        },
    }
}

/// What the file would hold after the tool runs, or `None` when the tool will fail by itself (the text to replace
/// isn't there), which is not this hook's to report.
fn proposed(tool: &str, input: &Value, old: Option<&str>) -> Option<String> {
    if tool == "Write" {
        return input["content"].as_str().map(str::to_owned);
    }
    let edits: Vec<Value> = if tool == "MultiEdit" { input["edits"].as_array()?.clone() } else { vec![input.clone()] };
    let mut text = old.unwrap_or_default().to_owned();
    for edit in &edits {
        let (from, to) = (edit["old_string"].as_str()?, edit["new_string"].as_str()?);
        if from.is_empty() {
            // Claude Code's way to create a file with Edit.
            if old.is_some() {
                return None;
            }
            text = to.to_owned();
        } else if edit["replace_all"].as_bool() == Some(true) {
            text = text.replace(from, to);
        } else {
            text = text.replacen(from, to, 1);
        }
    }
    Some(text)
}
