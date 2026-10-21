//! Markdown as the HTML subset Telegram shows: bold, italic, code, pre, links, quotes; tables as pre. A port of
//! `tg_html` in `kernel/lib/hq_bridge/telegram_chat.py`, step by step (the crate has no regex engine, so each
//! pattern is a small scanner), so that what the bridge showed is what this shows.

use std::fmt::Write as _;

/// Python's `html.escape`: `&`, `<`, `>`, and with `quote` also `"` and `'`.
pub fn escape(s: &str, quote: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if quote => out.push_str("&quot;"),
            '\'' if quote => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

pub fn tg_html(md: &str) -> String {
    let mut out = String::new();
    let mut rest = md;
    while let Some((start, end, lang, code)) = fence(rest) {
        out += &inline(&rest[..start]);
        let code = escape(code.trim_end(), true);
        if lang.is_empty() {
            let _ = write!(out, "<pre>{code}</pre>");
        } else {
            let _ = write!(out, "<pre><code class=\"language-{}\">{code}</code></pre>", escape(lang, true));
        }
        rest = &rest[end..];
    }
    out + &inline(rest)
}

/// The first "```lang\ncode```" in `text`: (start, end, lang, code).
fn fence(text: &str) -> Option<(usize, usize, &str, &str)> {
    // Without a newline or a closing fence after the first opener, none after it has either.
    let start = text.find("```")?;
    let line_end = start + 3 + text[start + 3..].find('\n')?;
    let close = line_end + 1 + text[line_end + 1..].find("```")?;
    Some((start, close + 3, text[start + 3..line_end].trim(), &text[line_end + 1..close]))
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn stash(keep: &mut Vec<String>, html: String) -> String {
    keep.push(html);
    format!("\0{}\0", keep.len() - 1)
}

fn inline(t: &str) -> String {
    let mut keep = Vec::new();
    let t = tables(t, &mut keep);
    let t = code_spans(&t, &mut keep);
    let t = links(&t, &mut keep);
    let t = escape(&t, false);
    let t = headings(&t);
    let t = bullets(&t);
    let t = pairs(&t, "**", "b");
    let t = underscore_bold(&t);
    let t = italic(&t, '*');
    let t = italic(&t, '_');
    let t = pairs(&t, "~~", "s");
    let t = quotes(&t);
    restore(&t, &keep)
}

/// Runs of two or more lines that start and end with `|`.
fn tables(t: &str, keep: &mut Vec<String>) -> String {
    let is_row = |line: &str| {
        let row = line.strip_suffix('\n').unwrap_or(line).trim_end_matches([' ', '\t']);
        row.len() >= 2 && row.starts_with('|') && row.ends_with('|')
    };
    let mut out = String::new();
    let mut run = String::new();
    let mut rows = 0;
    let flush = |out: &mut String, run: &mut String, rows: &mut usize, keep: &mut Vec<String>| {
        if *rows >= 2 {
            *out += &stash(keep, format!("<pre>{}</pre>\n", escape(run.trim_end(), true)));
        } else {
            *out += run;
        }
        run.clear();
        *rows = 0;
    };
    for line in t.split_inclusive('\n') {
        if is_row(line) {
            run += line;
            rows += 1;
        } else {
            flush(&mut out, &mut run, &mut rows, keep);
            out += line;
        }
    }
    flush(&mut out, &mut run, &mut rows, keep);
    out
}

/// `` `code` `` on one line.
fn code_spans(t: &str, keep: &mut Vec<String>) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        if t.as_bytes()[i] == b'`' {
            let rest = &t[i + 1..];
            if let Some(e) = rest.find(['`', '\n']).filter(|e| *e > 0 && rest.as_bytes()[*e] == b'`') {
                out += &stash(keep, format!("<code>{}</code>", escape(&rest[..e], true)));
                i += e + 2;
                continue;
            }
        }
        let c = t[i..].chars().next().unwrap_or('\0');
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

/// `[text](http…)`.
fn links(t: &str, keep: &mut Vec<String>) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        if t.as_bytes()[i] == b'['
            && let Some((len, html)) = link_at(&t[i..])
        {
            out += &stash(keep, html);
            i += len;
            continue;
        }
        let c = t[i..].chars().next().unwrap_or('\0');
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

fn link_at(t: &str) -> Option<(usize, String)> {
    let rest = &t[1..];
    let close = rest.find([']', '\n']).filter(|c| *c > 0 && rest.as_bytes()[*c] == b']')?;
    let text = &rest[..close];
    let after = rest[close + 1..].strip_prefix('(')?;
    let scheme = if after.starts_with("https://") {
        8
    } else if after.starts_with("http://") {
        7
    } else {
        return None;
    };
    let url_len = after[scheme..].find(|c: char| c == ')' || c.is_whitespace()).unwrap_or(after.len() - scheme);
    if url_len == 0 || after.as_bytes().get(scheme + url_len) != Some(&b')') {
        return None;
    }
    let url = &after[..scheme + url_len];
    let consumed = 1 + close + 1 + 1 + scheme + url_len + 1;
    Some((consumed, format!("<a href=\"{}\">{}</a>", escape(url, true), escape(text, true))))
}

/// `#{1,6}\s+(.+)$` at the start of a line -> (start, end) of the heading text.
fn heading_at(t: &str, p: usize) -> Option<(usize, usize)> {
    let hashes = t[p..].bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let ws_start = p + hashes;
    // After each whitespace character: where the text may start (whitespace can run over line ends).
    let mut ends = Vec::new();
    for (i, c) in t[ws_start..].char_indices() {
        if !c.is_whitespace() {
            break;
        }
        ends.push(ws_start + i + c.len_utf8());
    }
    // Greedy: the text starts after as much whitespace as still leaves something on the line.
    ends.iter().rev().find_map(|&start| {
        let end = start + t[start..].find('\n').unwrap_or(t.len() - start);
        (end > start).then_some((start, end))
    })
}

fn headings(t: &str) -> String {
    let mut out = String::new();
    let (mut copied, mut p) = (0, 0);
    loop {
        if p >= copied
            && let Some((s, e)) = heading_at(t, p)
        {
            out += &t[copied..p];
            let _ = write!(out, "<b>{}</b>", &t[s..e]);
            copied = e;
        }
        match t[p..].find('\n') {
            Some(n) => p += n + 1,
            None => break,
        }
    }
    out + &t[copied..]
}

/// `- item`, `* item`, `+ item` -> `• item`.
fn bullets(t: &str) -> String {
    let mut out = String::new();
    for line in t.split_inclusive('\n') {
        let body = line.trim_start_matches(|c: char| c.is_whitespace() && c != '\n');
        let lead = &line[..line.len() - body.len()];
        let mut chars = body.chars();
        if matches!(chars.next(), Some('-' | '*' | '+')) && chars.next() == Some(' ') {
            out += lead;
            out += "• ";
            out += &body[2..];
        } else {
            out += line;
        }
    }
    out
}

/// `**x**` and `~~x~~`: the nearest closing pair on the same line.
fn pairs(t: &str, delim: &str, tag: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        if t[i..].starts_with(delim) {
            let from = i + delim.len();
            let seg = &t[from..];
            let first = seg.chars().next().map_or(0, char::len_utf8);
            if first > 0
                && let Some(q) = seg[first..].find(delim).map(|q| q + first)
                && !seg[..q].contains('\n')
            {
                let _ = write!(out, "<{tag}>{}</{tag}>", &seg[..q]);
                i = from + q + delim.len();
                continue;
            }
        }
        let c = t[i..].chars().next().unwrap_or('\0');
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

/// `__x__` not inside a word.
fn underscore_bold(t: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        if t[i..].starts_with("__") && !t[..i].chars().next_back().is_some_and(word) {
            let from = i + 2;
            let seg = &t[from..];
            let first = seg.chars().next().map_or(0, char::len_utf8);
            let mut q = first;
            let mut found = None;
            while first > 0 && q <= seg.len() {
                let Some(at) = seg[q..].find("__").map(|n| n + q) else { break };
                if seg[..at].contains('\n') {
                    break;
                }
                if !seg[at + 2..].chars().next().is_some_and(word) {
                    found = Some(at);
                    break;
                }
                q = at + 1;
            }
            if let Some(at) = found {
                let _ = write!(out, "<b>{}</b>", &seg[..at]);
                i = from + at + 2;
                continue;
            }
        }
        let c = t[i..].chars().next().unwrap_or('\0');
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

/// `*x*` or `_x_`: not inside a word, no space just inside, not across lines.
fn italic(t: &str, mark: char) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        let c = t[i..].chars().next().unwrap_or('\0');
        if c == mark {
            let before_ok = !t[..i].chars().next_back().is_some_and(|p| word(p) || p == mark);
            let rest = &t[i + 1..];
            let next_ok = rest.chars().next().is_some_and(|n| !n.is_whitespace() && n != mark);
            if before_ok
                && next_ok
                && let Some(j) = rest.find([mark, '\n']).filter(|j| rest[*j..].starts_with(mark))
                && !rest[..j].chars().next_back().is_some_and(char::is_whitespace)
                && !rest[j + 1..].chars().next().is_some_and(|a| word(a) || a == mark)
            {
                let _ = write!(out, "<i>{}</i>", &rest[..j]);
                i += 1 + j + 1;
                continue;
            }
        }
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

/// Lines that start with `&gt;` (the escaped `>`).
fn quotes(t: &str) -> String {
    let mut out = String::new();
    let mut group = String::new();
    let flush = |out: &mut String, group: &mut String| {
        if group.is_empty() {
            return;
        }
        let lines: Vec<&str> = group
            .trim_end_matches('\n')
            .split('\n')
            .map(|l| {
                let l = l.strip_prefix("&gt;").unwrap_or(l);
                l.strip_prefix(' ').unwrap_or(l)
            })
            .collect();
        let _ = writeln!(*out, "<blockquote>{}</blockquote>", lines.join("\n"));
        group.clear();
    };
    for line in t.split_inclusive('\n') {
        if line.starts_with("&gt;") {
            group += line;
        } else {
            flush(&mut out, &mut group);
            out += line;
        }
    }
    flush(&mut out, &mut group);
    out
}

/// Puts the stashed pieces back; a piece can hold another's placeholder (code inside a link's text).
fn restore(t: &str, keep: &[String]) -> String {
    let mut text = t.to_owned();
    for _ in 0..3 {
        if !text.contains('\0') {
            break;
        }
        let mut out = String::new();
        let mut rest = text.as_str();
        while let Some(at) = rest.find('\0') {
            out += &rest[..at];
            let after = &rest[at + 1..];
            let digits = after.bytes().take_while(u8::is_ascii_digit).count();
            let piece = (digits > 0 && after.as_bytes().get(digits) == Some(&0))
                .then(|| after[..digits].parse::<usize>().ok().and_then(|n| keep.get(n)))
                .flatten();
            if let Some(piece) = piece {
                out += piece;
                rest = &after[digits + 1..];
            } else {
                out.push('\0');
                rest = after;
            }
        }
        out += rest;
        text = out;
    }
    text
}
