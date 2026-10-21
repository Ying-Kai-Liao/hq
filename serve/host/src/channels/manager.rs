//! Which bots run: every profile of discord, telegram and slack granted to the client `serve` in hq-auth is a
//! connection. Grants are looked at again every minute, so cutting a bot over from the bridge (grant it to `serve`,
//! revoke it from `bridge`) needs no restart, and a revoked one stops. Each connection is supervised on its own:
//! when it drops, fails or goes quiet it starts again after a pause that doubles up to five minutes.

use super::adapter::{Adapter, Constructor, Secrets};
use super::core::Core;
use super::hq::{self, Paths};
use crate::LockExt;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

/// The client name hq-auth knows this host by.
const CLIENT: &str = "serve";
const SYNC_EVERY: Duration = Duration::from_secs(60);

/// The secrets each platform's bot needs.
const PLATFORMS: [(&str, &[&str]); 3] = [
    ("discord", &["DISCORD_BOT_TOKEN"]),
    ("telegram", &["TELEGRAM_BOT_TOKEN"]),
    ("slack", &["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]),
];

/// Platform -> the constructor of its adapter.
#[derive(Default, Clone)]
pub struct Registry(HashMap<String, Constructor>);

impl Registry {
    pub fn add(&mut self, platform: &str, ctor: Constructor) {
        self.0.insert(platform.to_owned(), ctor);
    }

    /// The adapters this host has. Discord and Slack register here as they are ported.
    pub fn builtin() -> Self {
        let mut registry = Self::default();
        registry.add("telegram", super::telegram::constructor());
        registry.add("slack", super::slack::constructor());
        registry
    }
}

/// Connection -> state, for the host's status.
static STATES: Mutex<BTreeMap<String, &'static str>> = Mutex::new(BTreeMap::new());

fn set_state(conn: &str, state: &'static str) {
    STATES.locked().insert(conn.to_owned(), state);
}

/// The connections and what they are doing: `running`, `reconnecting` or `no adapter`.
pub fn status() -> Value {
    let states = STATES.locked();
    json!({"connections": states.iter().map(|(conn, state)| json!({"name": conn, "state": state})).collect::<Vec<_>>()})
}

/// The profiles granted to this host: (profile, platform). None when hq-auth can't be asked.
pub async fn granted(paths: &Paths) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    for (platform, _) in PLATFORMS {
        let o = hq::output(&paths.auth_bin, &["granted", "--for", CLIENT, platform]).await?;
        if !o.status.success() {
            return None; // an error is not "nothing granted": the connections that run keep running
        }
        out.extend(String::from_utf8_lossy(&o.stdout).split_whitespace().map(|p| (p.to_owned(), platform.to_owned())));
    }
    Some(out)
}

/// The secrets of one profile; logs (never a value) and gives None when one can't be had.
pub async fn secrets(paths: &Paths, profile: &str, platform: &str) -> Option<Secrets> {
    let names = PLATFORMS.iter().find(|(p, _)| *p == platform)?.1;
    let mut got = BTreeMap::new();
    for var in names {
        let o = hq::output(&paths.auth_bin, &["get", "--for", CLIENT, "--profile", profile, platform, var]).await;
        let value =
            o.as_ref().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            got.insert((*var).to_owned(), v);
        } else {
            let why = o.map(|o| String::from_utf8_lossy(&o.stderr).trim().to_owned()).filter(|s| !s.is_empty());
            tracing::warn!("{profile}: {}; not connecting it", why.unwrap_or_else(|| format!("{var} is empty")));
            return None;
        }
    }
    Some(Secrets(got))
}

/// How long to wait before starting a connection again.
#[derive(Clone, Copy, Debug)]
pub struct Backoff {
    pub first: Duration,
    pub max: Duration,
    /// A connection that stayed up this long starts over at `first`.
    pub healthy: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self { first: Duration::from_secs(5), max: Duration::from_secs(300), healthy: Duration::from_secs(600) }
    }
}

impl Backoff {
    /// The pause after a run that lasted `uptime`; `previous` is the pause before it (None for the first).
    pub fn pause(&self, previous: Option<Duration>, uptime: Duration) -> Duration {
        match previous {
            Some(p) if uptime <= self.healthy => (p * 2).min(self.max),
            _ => self.first,
        }
    }
}

/// Aborts the task when dropped.
struct AbortOnDrop(JoinHandle<anyhow::Result<()>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One connection: runs it, and when it drops, fails or goes quiet for `quiet()` seconds, starts it again.
pub async fn supervise(ad: Arc<dyn Adapter>, backoff: Backoff) {
    let conn = ad.conn().to_owned();
    let mut previous = None;
    loop {
        let began = Instant::now();
        ad.alive().touch();
        set_state(&conn, "running");
        // Dropped with this task (a revoked grant aborts the supervisor): the adapter's task goes too.
        let mut run = AbortOnDrop(tokio::spawn(ad.clone().start()));
        let check = ad.quiet().map_or(Duration::from_secs(15), |q| (q / 3).min(Duration::from_secs(15)));
        loop {
            tokio::select! {
                done = &mut run.0 => {
                    match done {
                        Ok(Ok(())) => tracing::info!("{conn}: connection ended"),
                        Ok(Err(e)) => tracing::warn!("{conn}: {e:#}"),
                        Err(e) => tracing::warn!("{conn}: {e}"),
                    }
                    break;
                }
                () = tokio::time::sleep(check) => {
                    let silent = ad.alive().silent_for();
                    if let Some(quiet) = ad.quiet().filter(|q| silent > *q) {
                        tracing::warn!("{conn}: nothing from it for {}s (limit {}s); restarting the connection", silent.as_secs(), quiet.as_secs());
                        run.0.abort();
                        let _ = tokio::time::timeout(Duration::from_secs(30), &mut run.0).await; // a call stuck in a thread is left behind
                        break;
                    }
                }
            }
        }
        let pause = backoff.pause(previous, began.elapsed());
        previous = Some(pause);
        set_state(&conn, "reconnecting");
        tracing::info!("{conn}: reconnecting in {}s", pause.as_secs());
        tokio::time::sleep(pause).await;
    }
}

pub struct Manager {
    core: Arc<Core>,
    registry: Registry,
    backoff: Backoff,
    running: HashMap<String, JoinHandle<()>>,
    /// Platforms already reported as having no adapter.
    noted: HashSet<String>,
}

impl Manager {
    pub fn new(core: Arc<Core>, registry: Registry, backoff: Backoff) -> Self {
        Self { core, registry, backoff, running: HashMap::new(), noted: HashSet::new() }
    }

    pub async fn run(mut self) {
        loop {
            self.sync().await;
            tokio::time::sleep(SYNC_EVERY).await;
        }
    }

    /// Starts the granted connections that aren't running and stops the ones whose grant is gone.
    pub async fn sync(&mut self) {
        let Some(grants) = granted(&self.core.paths).await else {
            tracing::warn!("channels: can't ask hq-auth which bots are granted; keeping what runs");
            return;
        };
        self.running.retain(|_, task| !task.is_finished());
        for (profile, platform) in &grants {
            if self.running.contains_key(profile) {
                continue;
            }
            let Some(ctor) = self.registry.0.get(platform).cloned() else {
                set_state(profile, "no adapter");
                if self.noted.insert(platform.clone()) {
                    tracing::info!("channels: no adapter for {platform}; {profile} stays with the bridge");
                }
                continue;
            };
            let Some(secrets) = secrets(&self.core.paths, profile, platform).await else { continue };
            self.core.import_bridge(profile);
            match ctor(profile, secrets, self.core.clone()) {
                Ok(ad) => {
                    tracing::info!("channels: connecting {profile}");
                    let backoff = self.backoff;
                    self.running.insert(profile.clone(), tokio::spawn(supervise(ad, backoff)));
                }
                Err(e) => tracing::warn!("{profile}: {e:#}; not connecting it"),
            }
        }
        let wanted: HashSet<&String> = grants.iter().map(|(p, _)| p).collect();
        let gone: Vec<String> = self.running.keys().filter(|c| !wanted.contains(c)).cloned().collect();
        for conn in gone {
            tracing::info!("channels: {conn} is no longer granted to {CLIENT}; stopping it");
            if let Some(task) = self.running.remove(&conn) {
                task.abort();
            }
            self.core.forget(&conn);
            STATES.locked().remove(&conn);
        }
        STATES.locked().retain(|conn, state| *state != "no adapter" || wanted.iter().any(|w| *w == conn));
    }

    pub fn running(&self) -> Vec<String> {
        let mut v: Vec<String> = self.running.keys().cloned().collect();
        v.sort();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pause_doubles_and_starts_over_after_a_healthy_run() {
        let b = Backoff::default();
        let s = Duration::from_secs;
        assert_eq!(b.pause(None, s(1)), s(5));
        assert_eq!(b.pause(Some(s(5)), s(1)), s(10));
        assert_eq!(b.pause(Some(s(10)), s(1)), s(20));
        assert_eq!(b.pause(Some(s(200)), s(1)), s(300));
        assert_eq!(b.pause(Some(s(300)), s(1)), s(300));
        assert_eq!(b.pause(Some(s(300)), s(601)), s(5));
    }
}
