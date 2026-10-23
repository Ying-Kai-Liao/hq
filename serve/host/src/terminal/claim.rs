//! The writer claim: one file per Claude session, `<state>/live/terminal/<session>.claim`, created exclusively. Whoever
//! holds it is the one writer of that session, even before the registry file (written by the session's own hook seconds
//! later) exists and even while the host is down. The kernel (`kernel/bin/kith-sessions`) writes and reads the same file.
//!
//! `{"pid": <claimer>, "procStart": "<ps lstart>", "at": "<rfc3339>", "kind": "terminal" | "app" | "bot", "takeover": bool}`
//!
//! A claim whose pid is gone, or whose pid now started at another time, is stale and is replaced under a lock file
//! (`<sid>.claim.lock`, flock). A claimer is a long-lived process: `kith <agent> --resume` claims for the shell
//! that then `exec`s into `kith-sessions run`, so the pid stays the same until claude has exited.
//!
//! The file is made whole in a temp file (`O_CREAT|O_EXCL`) and linked into place (`link` fails when the name exists), so
//! no reader ever sees an empty claim.
//!
//! Another kind of writer (a bot guest's `kith ask --thread`, see serve/host/README.md) calls
//! `take(state, sid, Kind::Bot, std::process::id(), false)` BEFORE it checks the registry and `hostBusy`, and `release`
//! when its turn is over.

use super::registry::{dir, pid_runs, safe_id};
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Terminal,
    App,
    Bot,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub pid: u32,
    #[serde(default)]
    pub proc_start: Option<String>,
    #[serde(default)]
    pub at: String,
    #[serde(default = "terminal")]
    pub kind: Kind,
    #[serde(default)]
    pub takeover: bool,
}

fn terminal() -> Kind {
    Kind::Terminal
}

impl Claim {
    /// The claimer still runs, and is the process that took the claim (a reused pid started at another time).
    pub fn is_live(&self) -> bool {
        if !pid_runs(self.pid) {
            return false;
        }
        match (&self.proc_start, start_of(self.pid)) {
            (Some(claimed), Some(actual)) => claimed.split_whitespace().collect::<Vec<_>>().join(" ") == actual,
            _ => true,
        }
    }
}

/// A take-over claims under its own name so the terminal's claim is left to its own `run`.
pub fn path(state: &Path, sid: &str, takeover: bool) -> PathBuf {
    dir(state).join(format!("{sid}.{}claim", if takeover { "takeover." } else { "" }))
}

/// Someone else holds the session.
#[derive(Debug, PartialEq, Eq)]
pub struct Held(pub Claim);

pub fn read(path: &Path) -> Option<Claim> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The live claim on `sid` (either name) that keeps the host from writing, if any. A host turn's own claim (`Kind::App`,
/// see `agent/bot/turn.rs`) is not one: it only keeps a terminal out. A take-over's claim is.
pub fn holder(state: &Path, sid: &str) -> Option<Claim> {
    [false, true]
        .into_iter()
        .filter_map(|t| read(&path(state, sid, t)))
        .filter(|c| c.kind != Kind::App || c.takeover)
        .find(Claim::is_live)
}

/// Takes the claim for `pid` (a running process). `Err(Held)`: a live claim is there. A stale claim is replaced under a
/// lock file next to it, so two takers never both judge it stale and one delete the other's fresh claim.
pub fn take(state: &Path, sid: &str, kind: Kind, pid: u32, takeover: bool) -> std::io::Result<Result<(), Held>> {
    if !safe_id(sid) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a session id"));
    }
    let dest = path(state, sid, takeover);
    let parent = dest.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mine = Claim { pid, proc_start: start_of(pid), at: chrono::Utc::now().to_rfc3339(), kind, takeover };
    let tmp = parent.join(format!(".{sid}.claim.{}.{}.tmp", std::process::id(), pid));
    write_new(&tmp, &serde_json::to_string(&mine).map_err(std::io::Error::other)?)?;
    let result = (|| {
        let _lock =
            Lock::exclusive(&parent.join(format!("{sid}.{}claim.lock", if takeover { "takeover." } else { "" })))?;
        for _ in 0..3 {
            match std::fs::hard_link(&tmp, &dest) {
                Ok(()) => return Ok(Ok(())),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            if let Some(seen) = read(&dest).filter(Claim::is_live) {
                return Ok(Err(Held(seen)));
            }
            // Stale, or garbage: removed while we hold the lock.
            let _ = std::fs::remove_file(&dest);
        }
        Ok(Err(Held(read(&dest).unwrap_or_else(|| mine.clone()))))
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

/// An advisory lock on a file, held until dropped.
struct Lock(#[allow(dead_code)] std::fs::File);

impl Lock {
    fn exclusive(path: &Path) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd as _;
            use std::os::unix::fs::OpenOptionsExt as _;
            let file = std::fs::OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).open(path)?;
            // SAFETY: the descriptor is open for the life of `file`.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self(file))
        }
        #[cfg(not(unix))]
        {
            Ok(Self(std::fs::OpenOptions::new().write(true).create(true).truncate(false).open(path)?))
        }
    }
}

/// The start time of `pid` as `ps` prints it in the C locale (the kernel's side writes the same text; the caller's locale
/// would print another one), whitespace squeezed.
fn start_of(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .env("LC_ALL", "C")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// Gives the claim back; only the claimer's own file is removed.
pub fn release(state: &Path, sid: &str, pid: u32, takeover: bool) {
    let p = path(state, sid, takeover);
    if read(&p).is_some_and(|c| c.pid == pid) {
        let _ = std::fs::remove_file(p);
    }
}

fn write_new(path: &Path, body: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt as _;
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600);
    opts.open(path)?.write_all(body.as_bytes())
}
