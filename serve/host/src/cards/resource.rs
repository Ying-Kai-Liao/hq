//! What a card is about: the resource key (A3, A6) and the things that are never carded (A5).
//!
//! The never-carded list mirrors the deny rules `kernel/bin/kith` writes into every run's Claude Code settings (the
//! `sensitive` list and the secrets folder, around line 475-497): the secrets folder, the kith serve token, device
//! identity and databases, browser profiles, the old bridge folder, the memory index and `memory.db*`. A request for
//! one of them is denied at once, with no card, whoever asks: a card cannot make a login or a credential fine to hand
//! to an agent. Keep the two lists in step; `SENSITIVE` is the one place on the host side.

use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::path::{Component, Path, PathBuf};

/// Patterns under a Kith state or machine folder (`*` matches within one segment, a trailing `/**` a whole folder).
pub const SENSITIVE: &[&str] = &[
    "secrets/**",
    "auth.json",
    "env",
    "serve/token",
    "serve/identity.json",
    "serve/*.db",
    "serve/*.db-*",
    "browsers/**",
    "bridge/**",
    "index/**",
    "memory.db*",
];

/// Tools whose input names one file by an absolute path, and the input fields that hold it.
const FILE_FIELDS: &[&str] = &["file_path", "path", "notebook_path"];
const FILE_TOOLS: &[&str] =
    &["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "Glob", "Grep", "LS"];

#[derive(Debug, PartialEq, Eq)]
pub enum Classified {
    /// Ask the approver about this.
    Card { key: String, shown: String },
    /// A secret or a login: no card, no.
    Never,
    /// Not a request the host can make a card of (say why).
    Malformed(&'static str),
}

/// The folders the sensitive patterns hang off: this Mac's Kith folder and the kernel's machine folder, as spelled
/// and as resolved (either may be a link).
pub fn roots() -> &'static [PathBuf] {
    static ROOTS: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut out: Vec<PathBuf> = Vec::new();
        let mut add = |p: PathBuf| {
            if p.is_absolute() {
                for q in [p.clone(), std::fs::canonicalize(&p).unwrap_or(p)] {
                    if !out.contains(&q) {
                        out.push(q);
                    }
                }
            }
        };
        add(crate::kernel::machine_dir(&dirs::home_dir().unwrap_or_default()));
        if let Some(k) = crate::kernel::current_kernel()
            && let Ok(o) = std::process::Command::new("python3").arg(k.join("lib/kith_paths.py")).arg("--json").output()
            && let Ok(v) = serde_json::from_slice::<Value>(&o.stdout)
        {
            for key in ["KITH_STATE", "KITH_MACHINE", "KITH_SECRETS"] {
                if let Some(p) = v[key].as_str() {
                    add(PathBuf::from(p));
                }
            }
        }
        out
    })
}

/// `*` inside one path segment.
fn wild(pat: &str, s: &str) -> bool {
    match pat.split_once('*') {
        None => pat == s,
        Some((head, tail)) => {
            s.starts_with(head)
                && (0..=s.len() - head.len())
                    .filter(|i| s.is_char_boundary(head.len() + i))
                    .any(|i| !s[head.len()..head.len() + i].contains('/') && wild(tail, &s[head.len() + i..]))
        }
    }
}

/// Whether `rel` (a path below a root, `/`-separated) matches a sensitive pattern.
fn sensitive_rel(rel: &str) -> bool {
    SENSITIVE.iter().any(|pat| match pat.strip_suffix("/**") {
        Some(dir) => rel == dir || rel.strip_prefix(dir).is_some_and(|r| r.starts_with('/')),
        None => wild(pat, rel),
    })
}

/// Whether `path` (absolute) is one of the never-carded files, under any of `roots`.
pub fn is_sensitive(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        path.strip_prefix(root)
            .ok()
            .and_then(|rel| rel.to_str())
            .is_some_and(|rel| !rel.is_empty() && sensitive_rel(rel))
    })
}

/// `path` without `.` and `..` (lexically), then with the longest existing part resolved through links: what the
/// file really is, whether or not it exists yet. `None` for a relative path.
pub fn resolve(path: &str) -> Option<PathBuf> {
    let home = dirs::home_dir();
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => home?.join(rest),
        None if path == "~" => home?,
        None => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for c in expanded.components() {
        match c {
            Component::ParentDir => {
                clean.pop();
            }
            Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }
    // The deepest ancestor that exists is resolved; what is below it is appended as written.
    let mut tail = Vec::new();
    let mut base = clean.as_path();
    loop {
        if let Ok(real) = std::fs::canonicalize(base) {
            let mut out = real;
            out.extend(tail.iter().rev());
            return Some(out);
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_owned());
                base = parent;
            }
            _ => return Some(clean),
        }
    }
}

/// A short stable digest of an input, so equal asks have equal keys whatever the key order.
pub fn digest(input: &Value) -> String {
    fn canon(v: &Value, out: &mut String) {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort();
                out.push('{');
                for k in keys {
                    out.push_str(&Value::String(k.clone()).to_string());
                    out.push(':');
                    canon(&m[k], out);
                    out.push(',');
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for x in a {
                    canon(x, out);
                    out.push(',');
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut s = String::new();
    canon(input, &mut s);
    Sha256::digest(s.as_bytes()).iter().take(12).fold(String::new(), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

/// Whether a command line names a sensitive place by its absolute address (or `~/`): a best effort for Bash, whose
/// real fence for a guest is the OS sandbox; the owner's own Bash is what the card is for.
fn command_names_secret(command: &str, roots: &[PathBuf]) -> bool {
    let home = dirs::home_dir();
    roots.iter().any(|root| {
        let mut spellings = vec![root.to_string_lossy().into_owned()];
        if let Some(rest) = home.as_ref().and_then(|h| root.strip_prefix(h).ok()) {
            spellings.push(format!("~/{}", rest.display()));
        }
        spellings.iter().any(|base| {
            SENSITIVE.iter().any(|pat| {
                // The literal start of the pattern: `secrets/**` -> `secrets`, `serve/*.db` -> `serve`.
                let lit = pat.split('*').next().unwrap_or_default().trim_end_matches('/');
                !lit.is_empty() && command.contains(&format!("{base}/{lit}"))
            })
        })
    })
}

/// Sorts a tool call into a card, a never, or a malformed ask. `roots` are the Kith folders (see [`roots`]).
pub fn classify(tool: &str, input: &Value, roots: &[PathBuf]) -> Classified {
    if tool.is_empty() || tool.len() > 200 || tool.chars().any(char::is_control) {
        return Classified::Malformed("the tool name is missing or malformed");
    }
    let by_path =
        FILE_TOOLS.contains(&tool) || (tool.starts_with("mcp__") && FILE_FIELDS.iter().any(|f| input[f].is_string()));
    if by_path && let Some(raw) = FILE_FIELDS.iter().find_map(|f| input[f].as_str()) {
        let Some(real) = resolve(raw) else {
            return Classified::Malformed("use an absolute path for files");
        };
        // Both the real address and the way it was written: a link into the secrets folder is a secret.
        if is_sensitive(&real, roots) || is_sensitive(Path::new(raw), roots) {
            return Classified::Never;
        }
        let shown = real.to_string_lossy().into_owned();
        return Classified::Card { key: format!("{tool}:{shown}"), shown };
    }
    if let Some(command) = input["command"].as_str()
        && command_names_secret(command, roots)
    {
        return Classified::Never;
    }
    let shown =
        input["command"].as_str().or_else(|| input["url"].as_str()).map_or_else(|| input.to_string(), str::to_owned);
    Classified::Card { key: format!("{tool}:{}", digest(input)), shown }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roots() -> Vec<PathBuf> {
        vec![PathBuf::from("/Users/x/.kith"), PathBuf::from("/Volumes/ssd/kith-state")]
    }

    #[test]
    fn secrets_and_logins_are_never_carded() {
        let r = roots();
        for p in [
            "/Users/x/.kith/secrets/env",
            "/Users/x/.kith/secrets",
            "/Users/x/.kith/auth.json",
            "/Users/x/.kith/serve/token",
            "/Users/x/.kith/serve/identity.json",
            "/Users/x/.kith/serve/kith.db",
            "/Users/x/.kith/serve/kith.db-wal",
            "/Users/x/.kith/browsers/profile/Cookies",
            "/Users/x/.kith/bridge/state",
            "/Users/x/.kith/index/mem",
            "/Users/x/.kith/memory.db",
            "/Users/x/.kith/memory.db-shm",
            "/Volumes/ssd/kith-state/secrets/env",
        ] {
            assert_eq!(classify("Read", &json!({"file_path": p}), &r), Classified::Never, "{p}");
            assert_eq!(classify("Edit", &json!({"file_path": p}), &r), Classified::Never, "{p}");
        }
        for p in [
            "/Users/x/.kith/projects/a.md",
            "/Users/x/.kith/serve/other.txt",
            "/Users/x/.kith/secretsy",
            "/tmp/auth.json",
        ] {
            assert!(matches!(classify("Read", &json!({"file_path": p}), &r), Classified::Card { .. }), "{p}");
        }
        assert_eq!(classify("Bash", &json!({"command": "cat /Users/x/.kith/secrets/env"}), &r), Classified::Never);
        assert_eq!(
            classify("Bash", &json!({"command": "cat /Volumes/ssd/kith-state/serve/token | pbcopy"}), &r),
            Classified::Never
        );
        assert!(matches!(classify("Bash", &json!({"command": "ls /tmp"}), &r), Classified::Card { .. }));
    }

    #[test]
    fn a_dotdot_or_a_link_into_the_secrets_is_still_the_secret() {
        let dir = std::env::temp_dir().join(format!("kc-{}", uuid::Uuid::new_v4().simple()));
        let secrets = dir.join("state/secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::create_dir_all(dir.join("other")).unwrap();
        std::os::unix::fs::symlink(&secrets, dir.join("other/innocent")).unwrap();
        let r = vec![std::fs::canonicalize(dir.join("state")).unwrap()];
        let via_dotdot = format!("{}/other/../state/secrets/env", dir.display());
        let via_link = format!("{}/other/innocent/env", dir.display());
        for p in [via_dotdot, via_link] {
            assert_eq!(classify("Read", &json!({"file_path": p}), &r), Classified::Never, "{p}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_card_names_the_resolved_real_path() {
        let dir = std::env::temp_dir().join(format!("kc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let real = std::fs::canonicalize(dir.join("real")).unwrap();
        let Classified::Card { key, shown } =
            classify("Write", &json!({"file_path": format!("{}/link/new/../a.txt", dir.display())}), &[])
        else {
            panic!("a card")
        };
        assert_eq!(shown, format!("{}/a.txt", real.display()), "links and dots resolved, a new file too");
        assert_eq!(key, format!("Write:{shown}"));
        assert!(matches!(classify("Read", &json!({"file_path": "relative/x"}), &[]), Classified::Malformed(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn equal_asks_have_equal_keys_whatever_the_field_order() {
        let a = classify("Bash", &json!({"command": "ls", "description": "list"}), &[]);
        let b =
            classify("Bash", &serde_json::from_str::<Value>(r#"{"description":"list","command":"ls"}"#).unwrap(), &[]);
        assert_eq!(a, b);
        assert_ne!(a, classify("Bash", &json!({"command": "ls -la", "description": "list"}), &[]));
        assert!(matches!(classify("", &json!({}), &[]), Classified::Malformed(_)));
    }
}
