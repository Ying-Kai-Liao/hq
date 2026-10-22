//! Jev, the router for messages sent while an agent works (see `chat::router`): finds its key and asks.
//!
//! The key is whatever the app chat finds (the environment or the saved vault), else the one granted to this
//! host in hq-auth (`hq-auth get --for serve jev-browser TYPESAFE_API_KEY`). It stays inside this process: runs
//! never see it, and it is never logged.

use super::hq::{self, Paths};
use crate::LockExt;
use crate::chat::router::{Jev, Route, Verdict};
use crate::hub::Hub;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A missing key is looked for again after this long, so granting one needs no restart.
const RETRY: Duration = Duration::from_secs(60);

enum Source {
    Hub(Arc<Hub>),
    Fixed(Option<Arc<Jev>>),
}

pub struct Judge {
    source: Source,
    paths: Paths,
    found: Mutex<Option<(Instant, Option<Arc<Jev>>)>>,
}

impl Judge {
    pub fn from_hub(hub: Arc<Hub>, paths: Paths) -> Self {
        Self { source: Source::Hub(hub), paths, found: Mutex::new(None) }
    }

    /// A router that is always `jev` (None: no router), for tests.
    pub fn fixed(jev: Option<Jev>, paths: Paths) -> Self {
        Self { source: Source::Fixed(jev.map(Arc::new)), paths, found: Mutex::new(None) }
    }

    async fn jev(&self) -> Option<Arc<Jev>> {
        if let Source::Fixed(jev) = &self.source {
            return jev.clone();
        }
        {
            let cache = self.found.locked();
            if let Some((at, jev)) = cache.as_ref()
                && (jev.is_some() || at.elapsed() < RETRY)
            {
                return jev.clone();
            }
        }
        let jev = self.find().await.map(Arc::new);
        *self.found.locked() = Some((Instant::now(), jev.clone()));
        jev
    }

    async fn find(&self) -> Option<Jev> {
        let Source::Hub(hub) = &self.source else { return None };
        if let Some(jev) = Jev::configured(hub).await {
            return Some(jev);
        }
        let out =
            hq::output(&self.paths.auth_bin, &["get", "--for", "serve", "jev-browser", "TYPESAFE_API_KEY"]).await?;
        let key = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (out.status.success() && !key.is_empty()).then(|| Jev::from_key(key))
    }

    /// How to handle `latest`, sent while `task` runs. Never fails: anything wrong merges.
    pub async fn route(&self, task: &str, recent: &[String], latest: &str, interrupt: bool) -> Verdict {
        match self.jev().await {
            Some(jev) => jev.judge(task, recent, latest, interrupt).await,
            None => Verdict { route: Route::Merge, hold: false, path: "no router".into() },
        }
    }
}
