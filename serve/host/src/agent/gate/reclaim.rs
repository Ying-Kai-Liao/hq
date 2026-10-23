//! After memory has held the line for a while, even with the host's own idle bots stopped, ask the
//! resource-manager agent's `res.py reclaim` to close clearly idle Claude Code sessions. This module only decides
//! when to ask and runs the script; the closing, the logging and the Telegram line are the script's.

use super::Settings;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A run that is still blocked afterwards is not repeated sooner than this.
pub const COOLDOWN: Duration = Duration::from_secs(30 * 60);
/// The script gets this long, then it is killed.
const TIMEOUT: Duration = Duration::from_secs(120);

/// When to run the script. Pure bookkeeping, so tests can drive it with their own clock.
#[derive(Default)]
pub struct Trigger {
    /// When memory started blocking the line, if it does now.
    blocked_since: Option<Instant>,
    /// The last time a run was started.
    last_run: Option<Instant>,
    /// The current stretch of blocking already had its run.
    ran_this_stretch: bool,
    running: bool,
}

impl Trigger {
    /// Call on every pass with whether memory blocks the line now. True means start the script now; the caller
    /// then reports back with [`Trigger::finished`].
    pub fn due(&mut self, now: Instant, memory_blocked: bool, settings: &Settings) -> bool {
        if !memory_blocked {
            self.blocked_since = None;
            self.ran_this_stretch = false;
            return false;
        }
        let since = *self.blocked_since.get_or_insert(now);
        if settings.reclaim_after.is_zero() || self.running || now.duration_since(since) < settings.reclaim_after {
            return false;
        }
        if self.ran_this_stretch && self.last_run.is_some_and(|t| now.duration_since(t) < COOLDOWN) {
            return false;
        }
        self.running = true;
        self.ran_this_stretch = true;
        self.last_run = Some(now);
        true
    }

    pub fn finished(&mut self) {
        self.running = false;
    }
}

/// `res.py` in the first agents folder that has the resource-manager.
pub fn find_script(roots: &[PathBuf]) -> Option<PathBuf> {
    roots.iter().map(|r| r.join("resource-manager/role/tools/res.py")).find(|p| p.is_file())
}

/// Runs `res.py reclaim`. The number of sessions it closed (0 when another run held its lock), or why it failed.
pub async fn run_script(script: &Path, settings: &Settings) -> Result<usize, String> {
    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg(script)
        .args(["reclaim", "--idle-hours", &settings.reclaim_idle_hours.to_string()])
        .args(["--min-free-percent", &settings.min_free_percent.to_string()])
        .args(["--max-swap-gb", &settings.max_swap_gb.to_string()])
        .args(["--by", "kith-serve"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("timed out after {} s", TIMEOUT.as_secs()))?
        .map_err(|e| format!("can't start python3: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{}: {}", out.status, stderr.trim()));
    }
    parse_closed(&out.stdout)
}

fn parse_closed(stdout: &[u8]) -> Result<usize, String> {
    let json: Value = serde_json::from_slice(stdout).map_err(|e| format!("output isn't JSON: {e}"))?;
    if json.get("busy").and_then(Value::as_bool) == Some(true) {
        return Ok(0);
    }
    json.get("closed").and_then(Value::as_array).map(Vec::len).ok_or_else(|| "output has no \"closed\" list".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_scripts_summary() {
        assert_eq!(parse_closed(br#"{"closed":[{"pid":1},{"pid":2}],"met":true}"#), Ok(2));
        assert_eq!(parse_closed(br#"{"busy":true}"#), Ok(0));
        assert!(parse_closed(b"oops").is_err());
        assert!(parse_closed(b"{}").is_err());
    }
}
