//! Self-heal for a hung host, like the bridge's watchdog. A tokio task proves the runtime and its blocking pool
//! still answer (a sleep, then a `spawn_blocking` round trip) and stamps a heartbeat; a plain OS thread, with no
//! tokio in it, checks that stamp. When it is older than the stall limit the process exits with code 70 and
//! launchd's `KeepAlive` starts a fresh one. The heartbeat touches neither the gate nor the bot actors, so heavy
//! load never looks like a stall.
//!
//! Time is `Instant`, which doesn't advance while the machine sleeps (`CLOCK_UPTIME_RAW` on macOS,
//! `CLOCK_MONOTONIC` on Linux), so waking from sleep is not a stall. Rust's docs leave sleep unspecified, and this
//! was not measured by sleeping a Mac. If a platform did count sleep, the worst case is one harmless restart
//! right after waking.
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Exit code of a stalled host (`EX_SOFTWARE`, as the bridge uses).
pub const EXIT_CODE: i32 = 70;
const DEFAULT_STALL_S: u64 = 180;
const BEAT_EVERY: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(15);

/// The stall limit: `KITH_SERVE_WATCHDOG_STALL_S`, then `watchdog_stall_s` in config.json, else 180 s.
/// `None` when it is 0 or "off" (disabled). Anything unusable falls back to the next source.
pub fn limit_from(file: Option<&Value>, env: Option<&str>) -> Option<Duration> {
    let parse = |raw: &str| -> Option<Option<u64>> {
        let raw = raw.trim();
        if raw.eq_ignore_ascii_case("off") {
            return Some(None);
        }
        raw.parse::<u64>().ok().map(|n| (n > 0).then_some(n))
    };
    let from_env = env.and_then(parse);
    let from_file = || {
        let v = file?.get("watchdog_stall_s")?;
        v.as_u64().map(|n| (n > 0).then_some(n)).or_else(|| v.as_str().and_then(parse))
    };
    from_env.or_else(from_file).unwrap_or(Some(DEFAULT_STALL_S)).map(Duration::from_secs)
}

/// Whether a heartbeat last stamped `since_beat` ago is a stall.
pub fn is_stalled(since_beat: Duration, limit: Duration) -> bool {
    since_beat > limit
}

/// Milliseconds since `origin` on the monotonic clock, shared between the beating task and the checker.
#[derive(Clone)]
pub struct Heartbeat {
    origin: Instant,
    last_ms: Arc<AtomicU64>,
}

impl Heartbeat {
    pub fn new() -> Self {
        Self { origin: Instant::now(), last_ms: Arc::new(AtomicU64::new(0)) }
    }

    pub fn beat(&self) {
        self.last_ms.store(u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    pub fn age(&self) -> Duration {
        self.origin.elapsed().saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }
}

/// The checker thread: every `every`, calls `on_stall(age)` and stops if the heartbeat is older than `limit`.
pub fn spawn_checker(
    heartbeat: Heartbeat,
    limit: Duration,
    every: Duration,
    on_stall: impl FnOnce(Duration) + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || {
            loop {
                std::thread::sleep(every);
                let age = heartbeat.age();
                if is_stalled(age, limit) {
                    on_stall(age);
                    return;
                }
            }
        })
        .expect("spawning the watchdog thread")
}

/// Debug builds only: `KITH_SERVE_WATCHDOG_FREEZE_BEAT=1` stops the beats, so a real process can be watched
/// exiting 70 without blocking its runtime from outside. Release builds never read it.
fn freeze_beat() -> bool {
    cfg!(debug_assertions) && std::env::var_os("KITH_SERVE_WATCHDOG_FREEZE_BEAT").is_some()
}

/// Starts the heartbeat task and the checker for the long-running `serve`. Call it from inside the runtime.
pub fn start() {
    let file = std::fs::read(crate::service::data_dir().join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(limit) = limit_from(file.as_ref(), std::env::var("KITH_SERVE_WATCHDOG_STALL_S").ok().as_deref()) else {
        tracing::info!("watchdog off");
        return;
    };
    let heartbeat = Heartbeat::new();
    heartbeat.beat();
    let beating = heartbeat.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(BEAT_EVERY).await;
            // The blocking pool is what the host's file and store work runs on; prove it answers too.
            if tokio::task::spawn_blocking(|| ()).await.is_ok() && !freeze_beat() {
                beating.beat();
            }
        }
    });
    spawn_checker(heartbeat, limit, CHECK_EVERY, move |age| {
        tracing::error!(
            stuck_s = age.as_secs(),
            limit_s = limit.as_secs(),
            "runtime stopped answering; exiting so launchd restarts the host"
        );
        // `exit` runs no destructors of ours; the OS drops host.lock with the process.
        std::process::exit(EXIT_CODE);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;

    #[test]
    fn the_limit_prefers_env_then_config_and_zero_or_off_disables() {
        let s = |n| Some(Duration::from_secs(n));
        assert_eq!(limit_from(None, None), s(180));
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": 60})), None), s(60));
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": 60})), Some("30")), s(30));
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": 0})), None), None);
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": "off"})), None), None);
        assert_eq!(limit_from(None, Some("0")), None);
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": 60})), Some("junk")), s(60));
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": -5})), None), s(180));
    }

    #[test]
    fn a_heartbeat_older_than_the_limit_is_a_stall() {
        assert!(!is_stalled(Duration::from_secs(180), Duration::from_secs(180)));
        assert!(is_stalled(Duration::from_secs(181), Duration::from_secs(180)));
    }

    #[test]
    fn the_checker_fires_once_the_heartbeat_stops() {
        let heartbeat = Heartbeat::new();
        let (tx, rx) = mpsc::channel();
        spawn_checker(heartbeat.clone(), Duration::from_millis(300), Duration::from_millis(50), move |age| {
            tx.send(age).unwrap();
        });
        // Kept alive: no stall.
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(50));
            heartbeat.beat();
        }
        assert!(rx.try_recv().is_err());
        // Stopped: it fires, with an age past the limit.
        let age = rx.recv_timeout(Duration::from_secs(3)).expect("the checker fires");
        assert!(age > Duration::from_millis(300));
    }

    #[test]
    fn exit_releases_the_instance_lock() {
        // flock is held by the open file description; a process that exits (even via `exit`) loses it.
        // Here: dropping the only handle frees it for the next taker, which is the same release path.
        let path = std::env::temp_dir().join(format!("kith-watchdog-lock-{}", std::process::id()));
        let first = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path).unwrap();
        fs2::FileExt::try_lock_exclusive(&first).unwrap();
        let second = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&second).is_err());
        drop(first);
        assert!(fs2::FileExt::try_lock_exclusive(&second).is_ok());
        let _ = std::fs::remove_file(path);
    }
}
