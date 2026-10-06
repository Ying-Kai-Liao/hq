//! Shared by the end-to-end tests.

use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// Stops a test host the way launchd does (SIGTERM), so it shuts down its own
/// children: a SIGKILL would orphan whatever it had running, such as a harness
/// sign-in check (`cursor-agent status` then spins forever). Kills it after 5 s.
pub fn stop(child: &mut Child) {
    let _ = Command::new("kill").arg(child.id().to_string()).status();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Python as the test machine names it.
pub fn python() -> &'static str {
    if cfg!(windows) { "python" } else { "python3" }
}

/// The agent command that runs a Python fixture (quoted for `sh -c` / `cmd /c`).
pub fn python_agent(script: &std::path::Path) -> String {
    let path = script.display().to_string();
    if cfg!(windows) {
        format!("{} -u \"{path}\"", python())
    } else {
        format!("{} -u '{}'", python(), path.replace('\'', "'\\''"))
    }
}
