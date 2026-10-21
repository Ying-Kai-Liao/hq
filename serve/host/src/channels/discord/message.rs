//! Reading a Discord message's text: the bot's own mention comes out, an agent's role becomes `@agent`.

use std::collections::HashMap;

/// `text` without the bot's mentions (`<@id>` or `<@!id>`, with the space around them folded into one), and
/// whether there was one.
pub fn strip_bot(text: &str, me: &str) -> (String, bool) {
    if me.is_empty() {
        return (text.trim().to_owned(), false);
    }
    let needles = [format!("<@{me}>"), format!("<@!{me}>")];
    let mut out = String::new();
    let mut rest = text;
    let mut found = false;
    while let Some((at, len)) =
        needles.iter().filter_map(|n| rest.find(n.as_str()).map(|i| (i, n.len()))).min_by_key(|(i, _)| *i)
    {
        found = true;
        out.push_str(rest[..at].trim_end());
        out.push(' ');
        rest = rest[at + len..].trim_start();
    }
    out.push_str(rest);
    (out.trim().to_owned(), found)
}

/// Role mentions (`<@&id>`) of agents become `@agent`; true when there was one.
pub fn agent_roles(text: &str, roles: &HashMap<String, String>) -> (String, bool) {
    let mut out = String::new();
    let mut rest = text;
    let mut found = false;
    while let Some(start) = rest.find("<@&") {
        let after = &rest[start + 3..];
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        if digits > 0
            && after[digits..].starts_with('>')
            && let Some(agent) = roles.get(&after[..digits])
        {
            out.push_str(&rest[..start]);
            out.push('@');
            out.push_str(agent);
            found = true;
            rest = &after[digits + 1..];
            continue;
        }
        out.push_str(&rest[..start + 3]);
        rest = after;
    }
    out.push_str(rest);
    (out, found)
}

/// A file name that stays in the folder it is saved to.
pub fn safe_name(name: &str, fallback: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim().trim_start_matches('.');
    if base.is_empty() { fallback.to_owned() } else { base.to_owned() }
}

/// Whether `a` and `b` name the same server: case and spaces don't matter.
pub fn squash(s: &str) -> String {
    s.split_whitespace().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bots_mention_comes_out_and_marks_the_message_addressed() {
        assert_eq!(strip_bot("<@42> hello", "42"), ("hello".into(), true));
        assert_eq!(strip_bot("hi  <@!42>  there", "42"), ("hi there".into(), true));
        assert_eq!(strip_bot("do it <@42>", "42"), ("do it".into(), true));
        assert_eq!(strip_bot("<@421> hello", "42"), ("<@421> hello".into(), false));
        assert_eq!(strip_bot("  plain ", "42"), ("plain".into(), false));
    }

    #[test]
    fn an_agents_role_is_the_same_as_typing_its_name() {
        let roles: HashMap<String, String> = [("7".to_owned(), "house".to_owned())].into();
        assert_eq!(agent_roles("<@&7> buy milk", &roles), ("@house buy milk".into(), true));
        assert_eq!(agent_roles("<@&8> and <@&7>", &roles), ("<@&8> and @house".into(), true));
        assert_eq!(agent_roles("<@&x> <@&7", &roles), ("<@&x> <@&7".into(), false));
    }

    #[test]
    fn file_names_cannot_leave_their_folder() {
        assert_eq!(safe_name("../../etc/passwd", "f"), "passwd");
        assert_eq!(safe_name("..", "f"), "f");
        assert_eq!(safe_name("a b.png", "f"), "a b.png");
        assert_eq!(squash(" My  Home "), "myhome");
    }
}
