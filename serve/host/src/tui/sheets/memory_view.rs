//! A bot's memory: about you, this bot's own, its dreams and its project's memory.

use super::{App, Buffer, Rect, centered, footer, frame_box, input_line, name_of, put, row, s, theme, u, window};
use crate::tui::manage::{MemoryMode, MemorySheet, Section};
use crate::tui::view::when;
use ratatui::widgets::{Paragraph, Widget, Wrap};
use serde_json::Value;

pub fn draw(buf: &mut Buffer, area: Rect, app: &App, memory: &MemorySheet) {
    let palette = theme();
    let rect = centered(area, 100, 30);
    let title = format!("{} · Memory", name_of(app, &memory.bot));
    let inner = frame_box(buf, rect, palette.text, palette.panel, Some((&title, palette.text)));
    tabs(buf, inner, memory);
    let body = Rect::new(inner.x, inner.y + 2, inner.width, inner.height.saturating_sub(5));
    let keys = match &memory.mode {
        MemoryMode::Edit { id, editor } => {
            let label = match (id, memory.section) {
                (Some(_), _) => "Change this memory",
                (None, Section::Yours) => "Something every bot should know about you",
                (None, _) => "Something this bot should remember",
            };
            put(buf, body.x, body.y, body.width, label, palette.secondary.patch(palette.panel));
            input_line(buf, body, body.y + 1, editor, "One short fact", true, false);
            "Enter save · Esc cancel"
        }
        MemoryMode::File { detail, .. } => {
            note(buf, body, app, memory, detail.as_ref());
            "↑↓ version · ↵ bring it back · e edit · x delete · Esc back"
        }
        MemoryMode::Browse => match memory.section {
            Section::Notes => {
                notes(buf, body, memory);
                "←→ section · ↑↓ move · ↵ open · n new note · Esc close"
            }
            Section::Yours | Section::Bot => {
                entries(buf, body, app, memory);
                "←→ section · ↑↓ move · n add · ↵ edit · p pin · a archive · x forget · s shared · D clear"
            }
            Section::Dreams => {
                dreams(buf, body, memory);
                "←→ section · ↑↓ move · u undo · r refresh · Esc close"
            }
            Section::Project => {
                project(buf, body, memory);
                "←→ section · read-only: the project's own notes · Esc close"
            }
        },
    };
    footer(buf, inner, memory.error.as_deref(), keys);
}

fn tabs(buf: &mut Buffer, inner: Rect, memory: &MemorySheet) {
    let palette = theme();
    let mut x = inner.x;
    for section in memory.sections() {
        let mut label = section.label().to_owned();
        let layer = match section {
            Section::Yours => Some("yours"),
            Section::Bot => Some("bot"),
            _ => None,
        };
        if let (Some(layer), Some(view)) = (layer, &memory.view) {
            label = format!("{label} {}/{}", view[layer]["used"], view[layer]["cap"]);
        }
        let style = if section == memory.section {
            palette.text.patch(palette.sel)
        } else {
            palette.secondary.patch(palette.panel)
        };
        x = put(buf, x, inner.y, inner.right().saturating_sub(x), &format!(" {label} "), style) + 1;
    }
    if memory.busy {
        put(buf, x, inner.y, inner.right().saturating_sub(x), "Loading…", palette.dim.patch(palette.panel));
    }
}

fn entries(buf: &mut Buffer, body: Rect, app: &App, memory: &MemorySheet) {
    let palette = theme();
    let Some(view) = &memory.view else { return };
    let note = match (memory.section, view["shared"] == true) {
        (Section::Yours, true) => "Shared by your bots · s stops this bot using it",
        (Section::Yours, false) => "This bot doesn't use what your bots share · s turns it on",
        _ => "What this bot learned about you",
    };
    put(buf, body.x, body.y, body.width, note, palette.secondary.patch(palette.panel));
    let rows = memory.rows();
    if rows.is_empty() {
        let empty = if memory.section == Section::Yours {
            "Nothing shared yet. Facts every bot should know (your name, time zone, people) go here."
        } else {
            "Nothing yet. What this bot learns about you shows up here, and you can change any of it."
        };
        put(buf, body.x, body.y + 2, body.width, empty, palette.secondary);
        return;
    }
    let height = usize::from(body.height.saturating_sub(2)) / 2;
    for (position, (index, e)) in rows.iter().enumerate().skip(window(memory.cursor, height)).take(height).enumerate() {
        let y = body.y + 2 + u(position * 2);
        let base = row(buf, body, y, index == memory.cursor);
        let archived = e["state"] == "archived";
        let text = format!("{}{}", if e["pinned"] == true { "● " } else { "" }, s(e, "text"));
        let style = if archived { palette.dim } else { palette.text };
        put(buf, body.x, y, body.width, &text, style.patch(base));
        let detail = format!(
            "{} · {}{}",
            author(app, e),
            when(e["updatedAt"].as_i64().unwrap_or(0)),
            if archived { " · archived" } else { "" }
        );
        put(buf, body.x, y + 1, body.width, &detail, palette.dim.patch(palette.panel));
    }
}

fn author(app: &App, e: &Value) -> String {
    match s(e, "author") {
        "user" => "You wrote it".into(),
        "bot" => format!("{} remembered it", name_of(app, s(e, "authorBot"))),
        "dream" => "Dreaming".into(),
        _ => "Moved from the old memory".into(),
    }
}

fn dreams(buf: &mut Buffer, body: Rect, memory: &MemorySheet) {
    let palette = theme();
    put(
        buf,
        body.x,
        body.y,
        body.width,
        "Between chats the bot tidies its memory from your own words. Each run can be undone.",
        palette.secondary.patch(palette.panel),
    );
    let rows = memory.rows();
    if rows.is_empty() {
        put(buf, body.x, body.y + 2, body.width, "No dreams yet.", palette.secondary);
        return;
    }
    let height = usize::from(body.height.saturating_sub(2)) / 2;
    for (position, (index, d)) in rows.iter().enumerate().skip(window(memory.cursor, height)).take(height).enumerate() {
        let y = body.y + 2 + u(position * 2);
        let base = row(buf, body, y, index == memory.cursor);
        let count = |k: &str| d[k].as_array().map_or(0, Vec::len);
        let head = format!(
            "{} · added {} · archived {}{}",
            when(d["at"].as_i64().unwrap_or(0)),
            count("added"),
            count("archived"),
            if d["undone"] == true { " · undone" } else { "" }
        );
        put(buf, body.x, y, body.width, &head, palette.text.patch(base));
        let changes: Vec<String> = d["added"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| format!("+ {}", s(c, "text")))
            .chain(d["archived"].as_array().into_iter().flatten().map(|c| format!("− {}", s(c, "text"))))
            .collect();
        put(buf, body.x, y + 1, body.width, &changes.join("  "), palette.dim.patch(palette.panel));
    }
}

/// Both layers' long-form notes: name, where it lives, description, size and date, marked past a cap.
fn notes(buf: &mut Buffer, body: Rect, memory: &MemorySheet) {
    let palette = theme();
    let Some(view) = &memory.view else { return };
    put(
        buf,
        body.x,
        body.y,
        body.width,
        "Longer notes, one topic each. The bot reads one when its topic comes up.",
        palette.secondary.patch(palette.panel),
    );
    let rows = memory.rows();
    if rows.is_empty() {
        put(buf, body.x, body.y + 2, body.width, "No notes yet. n writes one.", palette.secondary);
        return;
    }
    let cap = view["files"]["cap"].as_u64().unwrap_or(2_000);
    let height = usize::from(body.height.saturating_sub(2)) / 2;
    for (position, (index, f)) in rows.iter().enumerate().skip(window(memory.cursor, height)).take(height).enumerate() {
        let y = body.y + 2 + u(position * 2);
        let base = row(buf, body, y, index == memory.cursor);
        let deleted = f["deleted"] == true;
        let layer = if f["shared"] == true { "shared" } else { "this bot" };
        let head = format!("{} · {layer}{}", s(f, "name"), if deleted { " · deleted" } else { "" });
        put(buf, body.x, y, body.width, &head, if deleted { palette.dim } else { palette.text }.patch(base));
        let tokens = f["tokens"].as_u64().unwrap_or(0);
        let over = if tokens > cap && !deleted { format!(", over the {cap} cap") } else { String::new() };
        let detail =
            format!("{} · {tokens} tokens{over} · {}", s(f, "description"), when(f["updatedAt"].as_i64().unwrap_or(0)));
        put(buf, body.x, y + 1, body.width, &detail, palette.dim.patch(palette.panel));
    }
}

/// One note: what it holds, then its versions to bring one back.
fn note(buf: &mut Buffer, body: Rect, app: &App, memory: &MemorySheet, detail: Option<&Value>) {
    let palette = theme();
    let Some(detail) = detail else {
        put(buf, body.x, body.y, body.width, "Loading…", palette.dim.patch(palette.panel));
        return;
    };
    put(buf, body.x, body.y, body.width, s(detail, "path"), palette.dim.patch(palette.panel));
    let versions = detail["versions"].as_array().cloned().unwrap_or_default();
    let listed = u(versions.len().min(6));
    let text = Rect::new(body.x, body.y + 2, body.width, body.height.saturating_sub(4 + listed));
    let content = detail["content"].as_str().unwrap_or("Deleted. Bring back a version below.");
    Paragraph::new(content).wrap(Wrap { trim: false }).style(palette.text.patch(palette.panel)).render(text, buf);
    let top = text.bottom() + 1;
    put(buf, body.x, top, body.width, "Versions", palette.secondary.patch(palette.panel));
    for (position, (index, v)) in versions.iter().enumerate().skip(window(memory.cursor, 6)).take(6).enumerate() {
        let y = top + 1 + u(position);
        let base = row(buf, body, y, index == memory.cursor);
        let by = match s(v, "author") {
            "user" => "You".to_owned(),
            "bot" => name_of(app, s(v, "authorBot")),
            "dream" => "Dreaming".to_owned(),
            _ => "This computer".to_owned(),
        };
        let what = match s(v, "cause") {
            "delete" => "deleted it",
            "restore" => "brought back a version",
            "undo" => "undid a change",
            _ => "changed it",
        };
        let line = format!("{by} {what} · {}", when(v["at"].as_i64().unwrap_or(0)));
        put(buf, body.x, y, body.width, &line, palette.text.patch(base));
    }
}

fn project(buf: &mut Buffer, body: Rect, memory: &MemorySheet) {
    let palette = theme();
    let Some(project) = memory.view.as_ref().map(|v| &v["projectMemory"]) else { return };
    put(buf, body.x, body.y, body.width, s(project, "path"), palette.dim.patch(palette.panel));
    let text = Rect::new(body.x, body.y + 2, body.width, body.height.saturating_sub(2));
    Paragraph::new(s(project, "text"))
        .wrap(Wrap { trim: false })
        .scroll((u(memory.cursor), 0))
        .style(palette.text.patch(palette.panel))
        .render(text, buf);
}
