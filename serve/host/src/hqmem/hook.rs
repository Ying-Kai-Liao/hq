//! The Claude Code hooks on `Write`, `Edit` and `MultiEdit`: `pre` checks a memory write and blocks it with the reason,
//! `post` records it as a version. Anything that isn't a memory file returns at once.

use super::{HOOK_BUSY, Layout, Target, Who, guard, open_with, pieces_forgotten, read, record, sync};
use kith_mem::check::{self, Refusal};
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
    let cwd = event["cwd"].as_str().map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
    let Some(target) = layout.locate(Path::new(file), &cwd) else { return Outcome::default() };
    let who = if dream { Who::Dream(agent) } else { Who::Agent(agent) };
    // The content checks need no history, so a broken or locked memory.db never lets a bad write through.
    let pre = (phase == Phase::Pre).then(|| {
        let old = read(&target.path);
        let (new, inserted) = proposed(tool, &event["tool_input"], old.as_deref());
        (old, new, inserted)
    });
    if let Some((old, new, inserted)) = &pre {
        let refused =
            check::content(inserted).err().or_else(|| guard(None, Some(&target), who, old.as_deref(), new).err());
        if let Some(refusal) = refused {
            return deny(&target, refusal);
        }
    }
    let conn = match open_with(layout, HOOK_BUSY) {
        Ok(conn) => conn,
        Err(e) => {
            let stderr = format!("kith memory: history unavailable ({e:#}); the write is not recorded");
            return Outcome { stderr, ..Outcome::default() };
        }
    };
    match (phase, pre) {
        (Phase::Pre, Some((old, new, inserted))) => {
            // Whatever changed the file since its last version (a Bash command, an editor) is recorded first, so
            // undoing this write can go back to the file as it is now.
            if let Err(e) = sync(&conn, &target) {
                eprintln!("kith memory: {e:#}");
            }
            // What needs the history: facts the user told Kith to forget, and the warnings.
            if pieces_forgotten(&conn, &target, &inserted) {
                return deny(&target, Refusal::Forgotten);
            }
            match guard(Some(&conn), Some(&target), who, old.as_deref(), &new) {
                Err(refusal) => deny(&target, refusal),
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
        _ => match record(&conn, &target, who) {
            Ok(_) => Outcome::default(),
            Err(e) => {
                let stderr = format!("kith memory: could not record {}: {e:#}", target.label());
                Outcome { stderr, ..Outcome::default() }
            }
        },
    }
}

fn deny(target: &Target, refusal: Refusal) -> Outcome {
    Outcome {
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
    }
}

/// What the file would hold after the tool runs, and the text the tool inserts. Claude Code matches `old_string`
/// loosely (straight and curly quotes, line endings), so when it isn't found here the result is only a guess and
/// the inserted text is what gets checked. An empty file counts as a missing one, as it does for Claude Code.
fn proposed(tool: &str, input: &Value, old: Option<&str>) -> (String, String) {
    if tool == "Write" {
        let content = input["content"].as_str().unwrap_or_default().to_owned();
        return (content.clone(), content);
    }
    let edits: Vec<Value> =
        if tool == "MultiEdit" { input["edits"].as_array().cloned().unwrap_or_default() } else { vec![input.clone()] };
    let mut text = old.unwrap_or_default().to_owned();
    let mut inserted = Vec::new();
    for edit in &edits {
        let (from, to) =
            (edit["old_string"].as_str().unwrap_or_default(), edit["new_string"].as_str().unwrap_or_default());
        inserted.push(to);
        if from.is_empty() {
            if text.trim().is_empty() {
                to.clone_into(&mut text);
            }
        } else if edit["replace_all"].as_bool() == Some(true) {
            text = text.replace(from, to);
        } else {
            text = text.replacen(from, to, 1);
        }
    }
    (text, inserted.join("\n"))
}
