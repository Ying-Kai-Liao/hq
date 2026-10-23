//! Self-heal for a hung host, like the bridge's watchdog. A tokio task proves the async runtime still schedules
//! (a sleep, then a stamp); a plain OS thread, with no tokio in it, checks that stamp. When it is older than the
//! stall limit the process exits with code 70 and launchd's `KeepAlive` starts a fresh one. The heartbeat touches
//! neither the gate, the bot actors nor the blocking pool: a pool full of slow file reads (a stuck external disk,
//! a load average of 30) is a slow host, not a hung one, and killing it only restarted the same load. The pool is
//! probed separately and only reported. Before exiting, the watchdog logs what was in flight, and repeated exits
//! within an hour raise the limit (`backoff_limit`) so a slow host is not restart-looped.
//!
//! Time is `Instant`, which doesn't advance while the machine sleeps (`CLOCK_UPTIME_RAW` on macOS,
//! `CLOCK_MONOTONIC` on Linux), so waking from sleep is not a stall. Rust's docs leave sleep unspecified, and this
//! was not measured by sleeping a Mac. If a platform did count sleep, the worst case is one harmless restart
//! right after waking.
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Exit code of a stalled host (`EX_SOFTWARE`, as the bridge uses).
pub const EXIT_CODE: i32 = 70;
const DEFAULT_STALL_S: u64 = 180;
/// Below this a healthy host could trip: a beat is up to `BEAT_EVERY` old and the check runs every `CHECK_EVERY`.
const MIN_STALL_S: u64 = 30;
const BEAT_EVERY: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(15);

/// The stall limit: `KITH_SERVE_WATCHDOG_STALL_S`, then `watchdog_stall_s` in config.json, else 180 s.
/// `None` when it is 0 or "off" (disabled). Anything unusable falls back to the next source; a limit under
/// `MIN_STALL_S` is raised to it.
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
    from_env.or_else(from_file).unwrap_or(Some(DEFAULT_STALL_S)).map(|n| Duration::from_secs(n.max(MIN_STALL_S)))
}

/// Exits older than this no longer count towards the back-off.
const EXIT_WINDOW_S: u64 = 3600;
/// Each recent exit doubles the limit, up to this many doublings (180 s -> 24 min): a really deadlocked runtime
/// is still restarted, just not every three minutes.
const MAX_DOUBLINGS: u32 = 3;
const EXITS_FILE: &str = "watchdog-exits.json";

/// The stall limit after `recent` watchdog exits within the window.
pub fn backoff_limit(base: Duration, recent: usize) -> Duration {
    base * (1u32 << u32::try_from(recent).unwrap_or(u32::MAX).min(MAX_DOUBLINGS))
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Unix times of the watchdog exits still inside the window. A missing or unreadable file means none.
pub fn recent_exits(file: &Path, now: u64) -> Vec<u64> {
    let times: Vec<u64> = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    times.into_iter().filter(|t| *t <= now && now - t < EXIT_WINDOW_S).collect()
}

/// Records an exit at `now`; returns how many are in the window, this one included. A write failure is ignored:
/// the back-off is a nicety, the exit must happen.
pub fn record_exit(file: &Path, now: u64) -> usize {
    let mut times = recent_exits(file, now);
    times.push(now);
    let _ = std::fs::write(file, serde_json::to_vec(&times).unwrap_or_default());
    times.len()
}

type InFlight = (u64, HashMap<u64, (&'static str, Instant)>);

/// Blocking work in flight, by label, from submission (queued or running) on.
static IN_FLIGHT: Mutex<Option<InFlight>> = Mutex::new(None);

struct Tracked(u64);

impl Tracked {
    fn new(label: &'static str) -> Self {
        let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        let (next, map) = guard.get_or_insert_with(|| (0, HashMap::new()));
        *next += 1;
        map.insert(*next, (label, Instant::now()));
        Self(*next)
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        if let Some((_, map)) = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            map.remove(&self.0);
        }
    }
}

/// `tokio::task::spawn_blocking` that the watchdog can name if the pool backs up.
pub fn blocking<F, T>(label: &'static str, f: F) -> tokio::task::JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let tracked = Tracked::new(label);
    tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        f()
    })
}

/// How many labelled blocking jobs are queued or running (tokio's own pool counts are unstable API).
pub fn in_flight_count() -> usize {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map_or(0, |(_, m)| m.len())
}

/// The oldest labelled blocking work in flight, as `label=age_s`, at most `n` entries.
pub fn oldest_in_flight(n: usize) -> Vec<String> {
    let guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let mut all: Vec<_> = guard.as_ref().map(|(_, m)| m.values().copied().collect()).unwrap_or_default();
    all.sort_by_key(|(_, since): &(&str, Instant)| *since);
    all.into_iter().take(n).map(|(label, since)| format!("{label}={}s", since.elapsed().as_secs())).collect()
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
    let exits_file = crate::service::data_dir().join(EXITS_FILE);
    let recent = recent_exits(&exits_file, unix_now()).len();
    let base = limit;
    let limit = backoff_limit(base, recent);
    if recent > 0 {
        tracing::warn!(
            recent_exits = recent,
            base_s = base.as_secs(),
            limit_s = limit.as_secs(),
            "watchdog backing off"
        );
    }
    let heartbeat = Heartbeat::new();
    heartbeat.beat();
    let beating = heartbeat.clone();
    // Only the async runtime is proved here; the blocking pool has its own probe below.
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(BEAT_EVERY).await;
            if !freeze_beat() {
                beating.beat();
            }
        }
    });
    // When the pending blocking-pool probe was submitted, in ms since `origin` (0 when it answered).
    let origin = heartbeat.origin;
    let pool_pending_since = Arc::new(AtomicU64::new(0));
    let probe = pool_pending_since.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(BEAT_EVERY).await;
            probe.store(u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX).max(1), Ordering::Relaxed);
            let _ = tokio::task::spawn_blocking(|| ()).await;
            probe.store(0, Ordering::Relaxed);
        }
    });
    let handle = tokio::runtime::Handle::current();
    spawn_checker(heartbeat, limit, CHECK_EVERY, move |age| {
        let metrics = handle.metrics();
        let pending = pool_pending_since.load(Ordering::Relaxed);
        let pool_probe_s =
            if pending == 0 { 0 } else { origin.elapsed().saturating_sub(Duration::from_millis(pending)).as_secs() };
        let exits = record_exit(&exits_file, unix_now());
        tracing::error!(
            stuck_s = age.as_secs(),
            limit_s = limit.as_secs(),
            exits_in_window = exits,
            labelled_blocking = in_flight_count(),
            alive_tasks = metrics.num_alive_tasks(),
            pool_probe_pending_s = pool_probe_s,
            oldest_blocking = ?oldest_in_flight(8),
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
        assert_eq!(limit_from(Some(&json!({"watchdog_stall_s": 60})), Some("45")), s(45));
        // Too short to be safe with a 5 s beat and a 15 s check: raised to the floor.
        assert_eq!(limit_from(None, Some("1")), s(30));
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
    fn repeated_exits_raise_the_limit_to_a_cap() {
        let base = Duration::from_secs(180);
        assert_eq!(backoff_limit(base, 0), base);
        assert_eq!(backoff_limit(base, 1), base * 2);
        assert_eq!(backoff_limit(base, 3), base * 8);
        assert_eq!(backoff_limit(base, 50), base * 8);
    }

    #[test]
    fn exits_are_counted_in_a_window_and_old_ones_drop() {
        let file = std::env::temp_dir().join(format!("kith-wd-exits-{}", std::process::id()));
        let _ = std::fs::remove_file(&file);
        assert!(recent_exits(&file, 10_000).is_empty());
        assert_eq!(record_exit(&file, 10_000), 1);
        assert_eq!(record_exit(&file, 10_100), 2);
        assert_eq!(recent_exits(&file, 10_200).len(), 2);
        // Past the window the old ones no longer count.
        let later = 10_000 + EXIT_WINDOW_S + 50;
        assert_eq!(record_exit(&file, later), 2);
        // Junk is no history.
        std::fs::write(&file, b"nope").unwrap();
        assert!(recent_exits(&file, 10_000).is_empty());
        let _ = std::fs::remove_file(file);
    }

    #[tokio::test]
    async fn blocking_work_is_listed_until_it_finishes() {
        let (tx, rx) = mpsc::channel::<()>();
        let job = blocking("watchdog-test-job", move || rx.recv().ok());
        assert!(oldest_in_flight(100).iter().any(|e| e.starts_with("watchdog-test-job=")));
        tx.send(()).unwrap();
        job.await.unwrap();
        assert!(!oldest_in_flight(100).iter().any(|e| e.starts_with("watchdog-test-job=")));
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
