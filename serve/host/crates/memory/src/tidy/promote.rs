//! Promotion: a retag of a note (its audience, room, projects), proposed by tidying. The audience order lives here
//! and nowhere else in Rust (`kernel/lib/kith_facets.py` is its Python twin, with the same semantics):
//!
//! A move is allowed iff the readers of the new audience are a subset of the readers of the old one. The owner
//! reads everything, so only the other readers count. `shared` is read by everyone; `person:<a>` by `a`;
//! `room:<r>` by the room's members, which the caller's [`Roster`] knows or does not: a room it does not know has
//! unknown readers, and a move into it is a widening (fail closed). Adding or removing projects, or changing the
//! room tag without changing the audience, changes no readers and is allowed.
//!
//! A widening is never applied by tidying; the host asks the note's person (`asks`) and writes the wider audience
//! only after their approval (docs/memory-context.md, Promotion).

use std::collections::{BTreeSet, HashMap};
use std::fmt;

use serde::Deserialize;

use super::Plan;

/// Who may read a note.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Audience {
    Owner,
    Shared,
    Person(String),
    Room(String),
}

/// `a`, a room id or a person id: how the kernel's `kith_facets.ID` reads one.
pub fn valid_id(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

impl Audience {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Self::Owner),
            "shared" => Some(Self::Shared),
            _ => match s.split_once(':')? {
                ("person", id) if valid_id(id) => Some(Self::Person(id.to_owned())),
                ("room", id) if valid_id(id) => Some(Self::Room(id.to_owned())),
                _ => None,
            },
        }
    }

    /// Who is asked before this audience grows: the person a `person:` note is about, else the owner (`None`).
    pub fn asks(&self) -> Option<&str> {
        match self {
            Self::Person(id) => Some(id),
            _ => None,
        }
    }
}

impl fmt::Display for Audience {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Owner => f.write_str("owner"),
            Self::Shared => f.write_str("shared"),
            Self::Person(id) => write!(f, "person:{id}"),
            Self::Room(id) => write!(f, "room:{id}"),
        }
    }
}

/// The members of the rooms the caller knows, other than the owner.
#[derive(Clone, Debug, Default)]
pub struct Roster {
    rooms: HashMap<String, BTreeSet<String>>,
}

/// Who reads, besides the owner.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Readers {
    Everyone,
    Only(BTreeSet<String>),
    Unknown,
}

impl Roster {
    #[must_use]
    pub fn with_room(mut self, room: &str, members: &[&str]) -> Self {
        self.rooms
            .insert(room.to_owned(), members.iter().filter(|m| **m != "owner").map(|m| (*m).to_owned()).collect());
        self
    }

    fn readers(&self, a: &Audience) -> Readers {
        match a {
            Audience::Owner => Readers::Only(BTreeSet::new()),
            Audience::Shared => Readers::Everyone,
            Audience::Person(id) => Readers::Only(BTreeSet::from([id.clone()])),
            // A room nobody told us the members of has readers we cannot name.
            Audience::Room(id) => self.rooms.get(id).map_or(Readers::Unknown, |m| Readers::Only(m.clone())),
        }
    }

    /// The readers of an audience as a string that changes when they do (`*` everyone, `?` unknown). An approval
    /// is valid only for the readers it was asked about.
    pub fn fingerprint(&self, a: &Audience) -> String {
        match self.readers(a) {
            Readers::Everyone => "*".into(),
            Readers::Unknown => "?".into(),
            Readers::Only(set) => set.into_iter().collect::<Vec<_>>().join(","),
        }
    }

    /// Whether moving a note from `old` to `new` keeps its readers the same or fewer.
    pub fn within(&self, new: &Audience, old: &Audience) -> bool {
        if new == old || *new == Audience::Owner {
            return true;
        }
        match (self.readers(new), self.readers(old)) {
            (_, Readers::Everyone) => true,
            (Readers::Everyone | Readers::Unknown, _) | (_, Readers::Unknown) => false,
            (Readers::Only(n), Readers::Only(o)) => n.is_subset(&o),
        }
    }
}

/// A note's facets as they stand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteFacets {
    /// Path under the agent's `memory/`.
    pub file: String,
    pub audience: Audience,
    pub room: String,
    pub projects: Vec<String>,
}

/// The frontmatter's `key: value` lines and the text after it.
pub fn split_frontmatter(text: &str) -> (Vec<(String, String)>, &str) {
    let body = text.trim_start_matches('\u{feff}');
    let Some(rest) = body.strip_prefix("---").and_then(|r| r.strip_prefix('\n').or_else(|| r.strip_prefix("\r\n")))
    else {
        return (Vec::new(), text);
    };
    let mut offset = 0;
    let mut pairs = Vec::new();
    for (i, line) in rest.split_inclusive('\n').enumerate() {
        offset += line.len();
        if line.trim() == "---" {
            return (pairs, &rest[offset..]);
        }
        if i > 60 {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphabetic() || c == '_') {
                pairs.push((k.to_ascii_lowercase(), v.trim().trim_matches(['"', '\'']).to_owned()));
            }
        }
    }
    (Vec::new(), text)
}

fn list(v: &str) -> Vec<String> {
    v.trim_matches(['[', ']'])
        .split(',')
        .map(|p| p.trim().trim_matches(['"', '\'']).to_owned())
        .filter(|p| valid_id(p))
        .collect()
}

impl NoteFacets {
    /// The facets of the note at `rel` (under the agent's `memory/`) holding `text`: its folder's default, then its
    /// frontmatter. The audience in the frontmatter counts only when it is the default, `owner`, or a change
    /// `granted(change id, audience)` vouches for: a note's own text never widens it.
    pub fn read(agent: &str, rel: &str, text: &str, granted: &dyn Fn(i64, &str) -> bool) -> Self {
        let parts: Vec<&str> = rel.split('/').collect();
        let (mut audience, mut room, mut projects) = (Audience::Owner, String::new(), Vec::new());
        match parts[..] {
            ["shared", ..] => audience = Audience::Shared,
            ["people", id, _, ..] if valid_id(id) => {
                let id = id.to_ascii_lowercase();
                room = format!("1:1:{agent}:{id}");
                audience = Audience::Person(id);
            }
            ["rooms", id, _, ..] if valid_id(id) => {
                id.clone_into(&mut room);
                audience = Audience::Room(id.to_owned());
            }
            ["projects", id, _, ..] if valid_id(id) => projects = vec![id.to_owned()],
            _ => {}
        }
        let (front, _) = split_frontmatter(text);
        let get = |k: &str| front.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        if let Some(wanted) = get("audience").and_then(Audience::parse) {
            let change = get("approved_change").and_then(|c| c.parse().ok());
            if wanted == audience
                || wanted == Audience::Owner
                || change.is_some_and(|c| granted(c, &wanted.to_string()))
            {
                audience = wanted;
            }
        }
        if let Some(r) = get("room").filter(|r| !r.is_empty() && valid_id(&r.replace(':', "-"))) {
            r.clone_into(&mut room);
        }
        if let Some(p) = get("projects") {
            projects = list(p);
        }
        Self { file: rel.to_owned(), audience, room, projects }
    }
}

/// A retag the model proposes. Fields left out stay as they are.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct Promote {
    pub file: String,
    #[serde(default)]
    pub audience: Option<String>,
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub projects: Option<Vec<String>>,
    /// Why, in a few words, for the person who is asked.
    #[serde(default)]
    pub reason: String,
}

/// The facets a note would have after a retag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Retag {
    pub audience: Audience,
    pub room: String,
    pub projects: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Judgement {
    /// Same readers or fewer: tidying may apply it.
    Allowed(Retag),
    /// More readers (or readers it cannot tell): only the note's person can approve it.
    Widens(Retag),
    /// Nothing would change.
    Nothing,
}

/// What a retag of `current` would do. The audit calls it before the proposal is kept and the host again when it
/// applies it, because the membership may have changed in between.
pub fn judge(current: &NoteFacets, want: &Promote, roster: &Roster) -> Result<Judgement, &'static str> {
    let audience = match want.audience.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => Audience::parse(a).ok_or("not an audience")?,
        None => current.audience.clone(),
    };
    let room = match want.room.as_deref() {
        // A folder's room (a person's 1:1 room) can't be cleared by a tag, so an empty one means no change.
        Some("") | None => current.room.clone(),
        Some(r) if !valid_id(&r.replace(':', "-")) => return Err("not a room id"),
        Some(r) => r.to_owned(),
    };
    let mut projects = current.projects.clone();
    if let Some(wanted) = &want.projects {
        if wanted.iter().any(|p| !valid_id(p)) {
            return Err("not a project id");
        }
        projects.clone_from(wanted);
    }
    let retag = Retag { audience, room, projects };
    if retag.audience == current.audience && retag.room == current.room && retag.projects == current.projects {
        return Ok(Judgement::Nothing);
    }
    Ok(if roster.within(&retag.audience, &current.audience) {
        Judgement::Allowed(retag)
    } else {
        Judgement::Widens(retag)
    })
}

/// Keeps the proposals that name a note and ask for a valid, different tag; both the allowed and the widening ones
/// (the host applies the first and asks about the second).
pub(super) fn audit(snapshot: &super::Snapshot, promote: Vec<Promote>, kept: &mut Plan, rejected: &mut Vec<String>) {
    for p in promote {
        let Some(current) = snapshot.facets.iter().find(|f| f.file == p.file) else {
            rejected.push(format!("promote {}: no such note", p.file));
            continue;
        };
        match judge(current, &p, &snapshot.roster) {
            Err(why) => rejected.push(format!("promote {}: {why}", p.file)),
            Ok(Judgement::Nothing) => rejected.push(format!("promote {}: nothing would change", p.file)),
            Ok(_) if kept.promote.contains(&p) => rejected.push(format!("promote {}: proposed twice", p.file)),
            Ok(_) => kept.promote.push(p),
        }
    }
}

/// `content` with these frontmatter keys set (a `None` removes the key), creating the frontmatter when the file has
/// none. Other lines stay as they are.
pub fn set_frontmatter(content: &str, updates: &[(&str, Option<String>)]) -> String {
    let body = content.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = body.split('\n').collect();
    let close = if lines.first().is_some_and(|l| l.trim() == "---") {
        (1..lines.len().min(61)).find(|&i| lines[i].trim() == "---")
    } else {
        None
    };
    let (mut head, rest): (Vec<String>, &[&str]) = match close {
        Some(end) => (lines[1..end].iter().map(|l| (*l).to_owned()).collect(), &lines[end + 1..]),
        None => (Vec::new(), &lines[..]),
    };
    for (key, value) in updates {
        let prefix = format!("{key}:");
        head.retain(|l| !l.trim_start().to_ascii_lowercase().starts_with(&prefix));
        if let Some(v) = value {
            head.push(format!("{key}: {v}"));
        }
    }
    let mut out = vec!["---".to_owned()];
    out.extend(head);
    out.push("---".to_owned());
    out.extend(rest.iter().map(|l| (*l).to_owned()));
    out.join("\n")
}
