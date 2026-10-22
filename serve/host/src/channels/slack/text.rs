//! What Slack's message text becomes for the core, as the bridge made it.

use std::fmt::Write as _;

/// The app's own mention taken out (with the space around it), then `!command` as the core's `/command`, links
/// as Markdown, and Slack's three escapes undone.
pub fn clean(text: &str, me: &str) -> String {
    let mention = format!("<@{me}>");
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = (!me.is_empty()).then(|| rest.find(&mention)).flatten() {
        out.push_str(rest[..at].trim_end());
        out.push(' ');
        rest = rest[at + mention.len()..].trim_start();
    }
    out.push_str(rest);
    let out = out.trim();
    let out = out.strip_prefix('!').map_or_else(|| out.to_owned(), |c| format!("/{c}"));
    let linked = links(&out);
    linked.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// `<https://x|label>` -> `[label](https://x)`, `<https://x>` -> `https://x`.
fn links(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find("<http") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('>') else {
            rest = &rest[open..];
            break;
        };
        let inner = &after[..close];
        let url_len = inner.find('|').unwrap_or(inner.len());
        let (url, label) = (&inner[..url_len], inner.get(url_len + 1..).unwrap_or(""));
        if url.split_once("://").is_some_and(|(scheme, host)| matches!(scheme, "http" | "https") && !host.is_empty()) {
            if label.is_empty() {
                out.push_str(url);
            } else {
                let _ = write!(out, "[{label}]({url})");
            }
        } else {
            out.push_str(&rest[open..=open + close + 1]);
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

/// Whether `text` has an `@agent` word: an `@` that doesn't follow a word character or another `@`, then at
/// least one word character or hyphen.
pub fn has_agent_word(text: &str) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut before = None::<char>;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '@'
            && !before.is_some_and(|b| word(b) || b == '@')
            && chars.peek().is_some_and(|n| word(*n) || *n == '-')
        {
            return true;
        }
        before = Some(c);
    }
    false
}

/// A Slack timestamp (`1700000000.000200`) as unix seconds.
pub fn sent(ts: &str) -> Option<f64> {
    ts.parse().ok()
}
