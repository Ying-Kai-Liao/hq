//! The resource gate's limits: `<data dir>/config.json` (the file that holds `relay_url`), overridden by
//! `KITH_SERVE_*` environment variables. Read once at start; changing them takes a restart.

use serde_json::Value;
use std::time::Duration;

pub const DEFAULT_MAX_RUNNING: usize = 2;
pub const DEFAULT_MIN_FREE_PERCENT: f64 = 25.0;
pub const DEFAULT_MAX_SWAP_GB: f64 = 3.0;
pub const DEFAULT_IDLE_MINUTES: u64 = 10;
pub const DEFAULT_RECLAIM_SECONDS: u64 = 120;
pub const DEFAULT_RECLAIM_IDLE_HOURS: f64 = 3.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Agent turns in flight at once; always at least 1.
    pub max_running: usize,
    /// Less available memory than this percent makes a turn wait; 0 turns the check off.
    pub min_free_percent: f64,
    /// More swap in use than this many GB makes a turn wait; 0 turns the check off.
    pub max_swap_gb: f64,
    /// How long a bot may sit unused before its agent gives its memory back.
    pub idle_shutdown: Duration,
    /// Memory blocking the line this long (after the bots' own idle stop) runs the resource-manager's session
    /// reclaim; zero turns it off.
    pub reclaim_after: Duration,
    /// Only Claude Code sessions idle at least this many hours are closed by it.
    pub reclaim_idle_hours: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_running: DEFAULT_MAX_RUNNING,
            min_free_percent: DEFAULT_MIN_FREE_PERCENT,
            max_swap_gb: DEFAULT_MAX_SWAP_GB,
            idle_shutdown: Duration::from_secs(DEFAULT_IDLE_MINUTES * 60),
            reclaim_after: Duration::from_secs(DEFAULT_RECLAIM_SECONDS),
            reclaim_idle_hours: DEFAULT_RECLAIM_IDLE_HOURS,
        }
    }
}

impl Settings {
    /// The settings of this host: the environment, then the config file, then the defaults. Every
    /// value that is present but unusable is logged.
    pub fn load() -> Self {
        let file = std::fs::read(crate::service::data_dir().join("config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let (settings, warnings) = Self::from_sources(file.as_ref(), &|name| std::env::var(name).ok());
        for warning in warnings {
            tracing::warn!("{warning}");
        }
        settings
    }

    /// No limit and no memory check, for unit tests that run bots without caring about the gate.
    pub fn unlimited() -> Self {
        Self {
            max_running: 1024,
            min_free_percent: 0.0,
            max_swap_gb: 0.0,
            reclaim_after: Duration::ZERO,
            ..Self::default()
        }
    }

    /// `file`: the parsed config.json, if any. `env`: looks up an environment variable.
    pub fn from_sources(file: Option<&Value>, env: &dyn Fn(&str) -> Option<String>) -> (Self, Vec<String>) {
        let mut warnings = Vec::new();
        let mut pick = |key: &str, valid: &dyn Fn(f64) -> bool| -> Option<f64> {
            let var = format!("KITH_SERVE_{}", key.to_uppercase());
            if let Some(raw) = env(&var).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
                match raw.parse::<f64>().ok().filter(|n| valid(*n)) {
                    Some(n) => return Some(n),
                    None => warnings.push(format!("{var}={raw:?} isn't valid; ignoring it")),
                }
            }
            let value = file?.get(key)?;
            let n = value.as_f64().or_else(|| value.as_str()?.trim().parse().ok()).filter(|n| valid(*n));
            if n.is_none() {
                warnings.push(format!("config.json: {key} = {value} isn't valid; using the default"));
            }
            n
        };
        let whole = |n: f64| n.fract() == 0.0 && (1.0..=100_000.0).contains(&n);
        let max_running = pick("max_running_agents", &whole);
        let min_free = pick("min_free_memory_percent", &|n| (0.0..=100.0).contains(&n));
        let max_swap = pick("max_swap_used_gb", &|n| n.is_finite() && n >= 0.0);
        let idle = pick("idle_shutdown_minutes", &whole);
        let reclaim_after =
            pick("reclaim_sessions_after_seconds", &|n| n.fract() == 0.0 && (0.0..=86_400.0).contains(&n));
        let reclaim_hours = pick("reclaim_idle_hours", &|n| n.is_finite() && n > 0.0 && n <= 8760.0);
        let d = Self::default();
        // Validated whole numbers within 1..=100_000, so the casts lose nothing.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let settings = Self {
            max_running: max_running.map_or(d.max_running, |n| n as usize),
            min_free_percent: min_free.unwrap_or(d.min_free_percent),
            max_swap_gb: max_swap.unwrap_or(d.max_swap_gb),
            idle_shutdown: idle.map_or(d.idle_shutdown, |n| Duration::from_secs(n as u64 * 60)),
            reclaim_after: reclaim_after.map_or(d.reclaim_after, |n| Duration::from_secs(n as u64)),
            reclaim_idle_hours: reclaim_hours.unwrap_or(d.reclaim_idle_hours),
        };
        (settings, warnings)
    }

    /// Why a turn has to wait for this memory reading, or `None` when there is room.
    pub fn shortage(&self, memory: &super::memory::Memory) -> Option<String> {
        if self.min_free_percent > 0.0 && memory.free_percent < self.min_free_percent {
            return Some(format!("memory {:.0}% free", memory.free_percent));
        }
        if self.max_swap_gb > 0.0 && memory.swap_used_gb > self.max_swap_gb {
            return Some(format!("swap {:.1} GB used", memory.swap_used_gb));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::memory::Memory;
    use super::*;
    use serde_json::json;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn nothing_set_means_the_defaults() {
        let (s, warnings) = Settings::from_sources(None, &env_of(&[]));
        assert_eq!(s, Settings::default());
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(s.idle_shutdown, Duration::from_secs(600));
        assert_eq!((s.reclaim_after, s.reclaim_idle_hours), (Duration::from_secs(120), 3.0));
        let (s, warnings) = Settings::from_sources(Some(&json!({"relay_url": "https://x"})), &env_of(&[]));
        assert_eq!(s, Settings::default());
        assert_eq!(warnings, Vec::<String>::new());
    }

    #[test]
    fn the_config_file_sets_each_key_and_the_environment_wins() {
        let file = json!({
            "max_running_agents": 4, "min_free_memory_percent": 30, "max_swap_used_gb": 1.5, "idle_shutdown_minutes": 5,
            "reclaim_sessions_after_seconds": 60, "reclaim_idle_hours": 1.5
        });
        let (s, warnings) = Settings::from_sources(Some(&file), &env_of(&[]));
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(
            s,
            Settings {
                max_running: 4,
                min_free_percent: 30.0,
                max_swap_gb: 1.5,
                idle_shutdown: Duration::from_secs(300),
                reclaim_after: Duration::from_secs(60),
                reclaim_idle_hours: 1.5
            }
        );
        let env = env_of(&[("KITH_SERVE_MAX_RUNNING_AGENTS", "3"), ("KITH_SERVE_IDLE_SHUTDOWN_MINUTES", " 20 ")]);
        let (s, _) = Settings::from_sources(Some(&file), &env);
        assert_eq!(s.max_running, 3);
        assert_eq!(s.idle_shutdown, Duration::from_secs(1200));
        let env = env_of(&[("KITH_SERVE_RECLAIM_SESSIONS_AFTER_SECONDS", "0"), ("KITH_SERVE_RECLAIM_IDLE_HOURS", "6")]);
        let (s, _) = Settings::from_sources(Some(&file), &env);
        assert_eq!((s.reclaim_after, s.reclaim_idle_hours), (Duration::ZERO, 6.0));
        assert!((s.min_free_percent - 30.0).abs() < f64::EPSILON);
    }

    #[test]
    fn unusable_values_fall_back_with_a_warning() {
        let file = json!({"max_running_agents": 0, "min_free_memory_percent": 140, "max_swap_used_gb": -1, "idle_shutdown_minutes": "soon", "reclaim_sessions_after_seconds": -5, "reclaim_idle_hours": 0});
        let (s, warnings) = Settings::from_sources(Some(&file), &env_of(&[]));
        assert_eq!(s, Settings::default());
        assert_eq!(warnings.len(), 6);
        // A bad environment value falls to the file's, then the default.
        let env = env_of(&[("KITH_SERVE_MAX_RUNNING_AGENTS", "many")]);
        let (s, warnings) = Settings::from_sources(Some(&json!({"max_running_agents": 5})), &env);
        assert_eq!(s.max_running, 5);
        assert_eq!(warnings.len(), 1);
        let (s, _) = Settings::from_sources(None, &env_of(&[("KITH_SERVE_MAX_RUNNING_AGENTS", "0")]));
        assert_eq!(s.max_running, DEFAULT_MAX_RUNNING);
    }

    #[test]
    fn zero_turns_a_memory_check_off() {
        let low = Memory { free_percent: 5.0, swap_used_gb: 9.0 };
        let s = Settings::default();
        assert_eq!(s.shortage(&low).as_deref(), Some("memory 5% free"));
        let swapping = Memory { free_percent: 60.0, swap_used_gb: 3.4 };
        assert_eq!(s.shortage(&swapping).as_deref(), Some("swap 3.4 GB used"));
        assert_eq!(
            s.shortage(&Memory { free_percent: 25.0, swap_used_gb: 3.0 }),
            None,
            "the limits themselves are fine"
        );
        let no_free_check = Settings { min_free_percent: 0.0, ..s };
        assert_eq!(no_free_check.shortage(&low).as_deref(), Some("swap 9.0 GB used"));
        let off = Settings { max_swap_gb: 0.0, ..no_free_check };
        assert_eq!(off.shortage(&low), None);
    }
}
