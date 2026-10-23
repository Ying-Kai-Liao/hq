//! Claude Code's transcript (`~/.claude/projects/<folder>/<session>.jsonl`) read as chat items. Only the lines of the
//! main conversation count: sidechains (subagents), meta lines, slash-command wrappers, system reminders and compaction
//! summaries are left out. Nothing here logs what a line says.

use serde::Deserialize;
use serde_json::Value;

/// One thing said in the session, in the kinds the chat already has.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User {
        text: String,
        at: i64,
    },
    Agent {
        text: String,
        at: i64,
    },
    Thought {
        text: String,
        at: i64,
    },
    ToolUse {
        id: String,
        title: String,
        kind: &'static str,
        at: i64,
    },
    /// The outcome of the tool call `id`, which came earlier (maybe in an earlier chunk).
    ToolResult {
        id: String,
        output: String,
        failed: bool,
    },
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub items: Vec<Item>,
    /// Bytes of the chunk read: whole lines only, so the next read starts at a line.
    pub consumed: usize,
}

/// Longest text kept of one tool's output.
const OUTPUT_CAP: usize = 4000;
/// Longest tool title.
const TITLE_CAP: usize = 100;

/// What every line says about itself, read without the (possibly huge) message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(clippy::struct_excessive_bools, reason = "the transcript's own flags, read as they are")]
struct Head {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    is_sidechain: bool,
    #[serde(default)]
    is_meta: bool,
    #[serde(default)]
    is_compact_summary: bool,
    #[serde(default)]
    is_visible_in_transcript_only: bool,
    #[serde(default)]
    timestamp: String,
}

#[derive(Deserialize)]
struct Body {
    message: Value,
}

/// The items in `chunk` (starting at a line), skipping lines stamped at or before `since` ms. A last line without
/// its newline is left for the next read: the session may be writing it.
pub fn parse(chunk: &[u8], since: i64) -> Parsed {
    let mut out = Parsed::default();
    let mut rest = chunk;
    while let Some(end) = rest.iter().position(|b| *b == b'\n') {
        let (line, tail) = rest.split_at(end);
        rest = &tail[1..];
        out.consumed += line.len() + 1;
        if let Ok(line) = std::str::from_utf8(line) {
            line_items(line, since, &mut out.items);
        }
    }
    out
}

fn line_items(line: &str, since: i64, items: &mut Vec<Item>) {
    let Ok(head) = serde_json::from_str::<Head>(line) else { return };
    if !matches!(head.kind.as_str(), "user" | "assistant")
        || head.is_sidechain
        || head.is_meta
        || head.is_compact_summary
        || head.is_visible_in_transcript_only
    {
        return;
    }
    let at = chrono::DateTime::parse_from_rfc3339(&head.timestamp).map_or(0, |t| t.timestamp_millis());
    if since > 0 && at <= since {
        return;
    }
    let Ok(Body { message }) = serde_json::from_str::<Body>(line) else { return };
    if head.kind == "user" {
        user_items(&message["content"], at, items);
    } else if message["model"] != "<synthetic>" {
        assistant_items(&message["content"], at, items);
    }
}

fn user_items(content: &Value, at: i64, items: &mut Vec<Item>) {
    let mut texts = Vec::new();
    match content {
        Value::String(text) => texts.push(text.as_str()),
        Value::Array(blocks) => {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => texts.extend(block["text"].as_str()),
                    Some("tool_result") => {
                        let id = block["tool_use_id"].as_str().unwrap_or_default().to_owned();
                        let output = cap(&result_text(&block["content"]), OUTPUT_CAP);
                        items.push(Item::ToolResult { id, output, failed: block["is_error"] == true });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    for text in texts {
        if let Some(text) = typed(text) {
            items.push(Item::User { text, at });
        }
    }
}

/// Tags Claude Code wraps around what is not something the user typed to the agent.
const WRAPPERS: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<task-notification>",
    "<system-reminder>",
    // What Kith itself hands the agent at the start of a session.
    "<agent-profile>",
    "<kith-",
    "<hq-",
    "[Request interrupted by user",
];

/// What the user typed in `text`, or None when it is a wrapper or empty once reminders are taken out.
fn typed(text: &str) -> Option<String> {
    let text = without_reminders(text);
    let text = text.trim();
    if text.is_empty() || WRAPPERS.iter().any(|w| text.starts_with(w)) {
        return None;
    }
    Some(text.to_owned())
}

/// `text` without its `<system-reminder>` blocks, which Claude Code appends to what was typed.
fn without_reminders(text: &str) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        match rest[start..].find(CLOSE) {
            Some(end) => rest = &rest[start + end + CLOSE.len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn assistant_items(content: &Value, at: i64, items: &mut Vec<Item>) {
    let Some(blocks) = content.as_array() else { return };
    for block in blocks {
        match block["type"].as_str() {
            Some("text") => {
                if let Some(text) = block["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    items.push(Item::Agent { text: text.to_owned(), at });
                }
            }
            Some("thinking") => {
                if let Some(text) = block["thinking"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    items.push(Item::Thought { text: text.to_owned(), at });
                }
            }
            Some("tool_use") => {
                let name = block["name"].as_str().unwrap_or("Tool");
                items.push(Item::ToolUse {
                    id: block["id"].as_str().unwrap_or_default().to_owned(),
                    title: title(name, &block["input"]),
                    kind: tool_kind(name),
                    at,
                });
            }
            _ => {}
        }
    }
}

/// The chat's tool kinds (`toolKind`) for Claude Code's tools.
fn tool_kind(name: &str) -> &'static str {
    match name {
        "Read" | "NotebookRead" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Bash" | "BashOutput" | "KillShell" => "execute",
        "Grep" | "Glob" | "LS" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        "Task" | "Agent" => "think",
        _ => "other",
    }
}

/// "Read /path", "Bash ls -la": the tool and the argument that says what it does.
fn title(name: &str, input: &Value) -> String {
    let arg = ["file_path", "path", "command", "pattern", "url", "query", "description", "prompt"]
        .iter()
        .find_map(|k| input[*k].as_str().filter(|s| !s.trim().is_empty()));
    let line = arg.and_then(|a| a.trim().lines().next()).unwrap_or_default();
    cap(&format!("{name} {line}"), TITLE_CAP).trim().to_owned()
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// `text` cut to `max` characters, marked when it was.
fn cap(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push('…');
    cut
}
