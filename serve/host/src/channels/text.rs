//! Text helpers the core and the adapters share: cutting long answers, ids, the notes a prompt starts with.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// Told at the start of a turn that redoes work the user corrected mid-run.
pub const INTERRUPTED: &str = "(Your previous attempt at this was stopped part-way because the user corrected it; files or other things it touched may be half-changed, so check before you go on.)\n\n";

/// What the agent is told about a message that waited for the host.
pub fn late_note(sent: f64) -> String {
    #[allow(clippy::cast_possible_truncation)]
    let sent = chrono::DateTime::from_timestamp(sent as i64, 0).unwrap_or_default().with_timezone(&chrono::Local);
    format!(
        "(Sent at {} while hq's chat bridge was away; it reached you at {}. Say briefly that you picked it up late.)\n\n",
        sent.format("%Y-%m-%d %H:%M"),
        chrono::Local::now().format("%H:%M")
    )
}

/// A short stable id for `text` (thread boxes, pending asks, stop buttons).
pub fn short(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(5).fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Several queued messages as one prompt.
pub fn merged(items: &[String]) -> String {
    if let [one] = items {
        return one.clone();
    }
    let numbered: Vec<String> = items.iter().enumerate().map(|(i, t)| format!("[{}] {t}", i + 1)).collect();
    format!("The user sent several messages in a row; answer them together, in one reply:\n\n{}", numbered.join("\n\n"))
}

/// Pieces of at most `n` characters, cut at line ends, with a code fence cut in two closed and reopened.
pub fn chunks(text: &str, n: usize) -> Vec<String> {
    let trimmed = text.trim();
    let mut text: Vec<char> =
        if trimmed.is_empty() { "(no reply)".chars().collect() } else { trimmed.chars().collect() };
    let mut out = Vec::new();
    let mut fence = String::new();
    let room = n.saturating_sub(8).max(1);
    while !text.is_empty() {
        let cut = if text.len() > room {
            match text[..room].iter().rposition(|c| *c == '\n') {
                Some(i) if i > n / 2 => i,
                _ => room,
            }
        } else {
            text.len()
        };
        let mut part = format!("{fence}{}", text[..cut].iter().collect::<String>());
        let skipped = text[cut..].iter().take_while(|c| **c == '\n').count();
        text.drain(..cut + skipped);
        let opened: Vec<String> = part
            .lines()
            .filter_map(|l| l.strip_prefix("```"))
            .map(|rest| rest.split_whitespace().next().unwrap_or("").to_owned())
            .collect();
        fence = String::new();
        if opened.len() % 2 == 1 && !text.is_empty() {
            part.push_str("\n```");
            fence = format!("```{}\n", opened[opened.len() - 1]);
        }
        out.push(part);
    }
    out
}

/// How full the session's context is after this turn, in percent; None when the result doesn't say.
pub fn context_pct(res: &Value) -> Option<f64> {
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    // The turn's final API call: what the next turn starts from.
    let last = res.get("usage")?.get("iterations")?.as_array()?.last()?;
    let used: f64 = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]
        .iter()
        .map(|k| num(last, k))
        .sum();
    let total = |m: &Value| num(m, "inputTokens") + num(m, "cacheReadInputTokens") + num(m, "cacheCreationInputTokens");
    // The agent's own model, not a helper's.
    let main = res
        .get("modelUsage")?
        .as_object()?
        .values()
        .filter(|m| num(m, "contextWindow") > 0.0)
        .max_by(|a, b| total(a).total_cmp(&total(b)))?;
    Some(100.0 * used / num(main, "contextWindow"))
}

/// The last `n` characters of `s`.
pub fn last_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    s.char_indices().nth(count.saturating_sub(n)).map_or(s, |(i, _)| &s[i..])
}

/// The first `n` characters of `s`.
pub fn first_chars(s: &str, n: usize) -> &str {
    s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `/name rest` or `!name rest` as the whole message: (lowercase name, rest).
pub fn command(text: &str) -> Option<(String, String)> {
    let body = text.trim().strip_prefix(['/', '!'])?;
    let name: String = body.chars().take_while(|c| word(*c)).collect();
    if name.is_empty() {
        return None;
    }
    Some((name.to_lowercase(), body[name.len()..].trim().to_owned()))
}

/// The length in bytes of a leading `@agent` / `/agent` (with an optional `,` or `:`), after leading spaces.
fn lead_len(text: &str) -> Option<(usize, String)> {
    let skipped = text.len() - text.trim_start().len();
    let body = text[skipped..].strip_prefix(['@', '/'])?;
    let name: String = body.chars().take_while(|c| word(*c) || *c == '-').collect();
    if name.is_empty() {
        return None;
    }
    let after = &body[name.len()..];
    let comma = usize::from(after.starts_with([',', ':']));
    Some((skipped + 1 + name.len() + comma, name))
}

/// A leading `@agent` / `/agent`: (the word, the rest after it and the spaces that follow).
pub fn lead(text: &str) -> Option<(String, String)> {
    let (len, name) = lead_len(text)?;
    Some((name, text[len..].trim_start().to_owned()))
}

/// Every `@word` that doesn't follow a word character, `@`, `/` or `<`.
pub fn mentions(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !(word(chars[i - 1]) || "@/<".contains(chars[i - 1]))) {
            let name: String = chars[i + 1..].iter().take_while(|c| word(**c) || **c == '-').collect();
            if !name.is_empty() {
                i += 1 + name.chars().count();
                out.push(name);
                continue;
            }
        }
        i += 1;
    }
    out
}

/// A thread's title from the message that started it: without the leading `@agent`, one line, 90 characters.
pub fn title(text: &str) -> String {
    let rest = lead_len(text).map_or(text, |(len, _)| &text[len..]);
    let one_line = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = first_chars(&one_line, 90);
    if cut.is_empty() { "task".into() } else { cut.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn last_chars_keeps_the_end() {
        assert_eq!(last_chars("abc", 5), "abc");
        assert_eq!(last_chars("停一下好嗎", 2), "好嗎");
    }

    #[test]
    fn short_texts_are_one_piece() {
        assert_eq!(chunks("hello", 1900), vec!["hello"]);
        assert_eq!(chunks("   ", 1900), vec!["(no reply)"]);
    }

    #[test]
    fn long_text_is_cut_at_line_ends() {
        let text = (0..40).map(|i| format!("line {i} {}", "x".repeat(40))).collect::<Vec<_>>().join("\n");
        let parts = chunks(&text, 500);
        assert!(parts.len() > 3);
        assert!(parts.iter().all(|p| p.chars().count() <= 500), "{parts:?}");
        assert_eq!(parts.join("\n"), text);
    }

    #[test]
    fn a_fence_cut_in_two_is_closed_and_reopened() {
        let body = (0..30).map(|i| format!("code line {i}")).collect::<Vec<_>>().join("\n");
        let parts = chunks(&format!("```rust\n{body}\n```"), 200);
        assert!(parts.len() > 1);
        assert!(parts[0].ends_with("\n```"), "{:?}", parts[0]);
        assert!(parts[1].starts_with("```rust\n"), "{:?}", parts[1]);
        assert!(parts.last().unwrap().ends_with("```"));
    }

    #[test]
    fn chunks_never_split_a_character() {
        let text = "停一下好嗎".repeat(100);
        assert_eq!(chunks(&text, 100).concat(), text);
    }

    #[test]
    fn merged_numbers_several_messages() {
        assert_eq!(merged(&["one".into()]), "one");
        let two = merged(&["a".into(), "b".into()]);
        assert!(two.contains("[1] a") && two.contains("[2] b"));
    }

    #[test]
    fn commands_leads_and_mentions() {
        assert_eq!(command("  /Default  house "), Some(("default".into(), "house".into())));
        assert_eq!(command("!stop"), Some(("stop".into(), String::new())));
        assert_eq!(command("hello /stop"), None);
        assert_eq!(lead("@house, do it"), Some(("house".into(), "do it".into())));
        assert_eq!(lead("/my-agent: x"), Some(("my-agent".into(), "x".into())));
        assert_eq!(lead("hi @house"), None);
        assert_eq!(mentions("ask @house and @a-b; mail me@x.com </@no"), vec!["house", "a-b"]);
        assert_eq!(title("@house  buy   milk"), "buy milk");
        assert_eq!(title("@house"), "task");
        assert_eq!(title(&"y".repeat(200)).chars().count(), 90);
    }

    #[test]
    fn context_percent_uses_the_last_call_and_the_main_model() {
        let res = json!({
            "usage": {"iterations": [{"input_tokens": 1}, {"input_tokens": 100, "cache_read_input_tokens": 300, "output_tokens": 100}]},
            "modelUsage": {
                "main": {"contextWindow": 1000, "inputTokens": 500, "cacheReadInputTokens": 400},
                "helper": {"contextWindow": 100, "inputTokens": 5}
            }
        });
        assert!((context_pct(&res).unwrap() - 50.0).abs() < 1e-9);
        assert!(context_pct(&json!({"result": "x"})).is_none());
    }

    #[test]
    fn late_note_says_so() {
        assert!(late_note(1_700_000_000.0).contains("picked it up late"));
    }
}
