//! The sessions of an hq agent's bot: `hq <agent> --launch-json` says how to start it (see `agent::hq`), and
//! nothing of Kith's goes in with it — no instructions of its own, no `chat`/`memory`/`team`/`routines` servers,
//! no memory snapshot, no dreaming. The agent's reply is its turn's text.

use super::fast_mode::Listing;
use super::launch::{launch_commands, start_agent};
use super::{Actor, NoticeStyle};
use crate::agent::acp::Incoming;
use crate::agent::{folder, hq};
use anyhow::{Result, anyhow, bail};
use std::time::{Duration, Instant};

impl Actor {
    pub(super) fn is_hq(&self) -> bool {
        self.cfg.is_hq()
    }

    /// What the prompt of an hq bot's turn is: the user's words, with the notes the host owes the agent (an earlier
    /// conversation's handoff, where a thread branches off). Nothing about Kith.
    pub(super) fn compose_hq(&mut self, text: &str) -> String {
        self.session_fresh = false;
        let mut prompt = text.to_owned();
        if let Some(handoff) = self.handoff.take() {
            prompt = format!("{handoff}\n\n{prompt}");
        }
        if let Some(intro) = self.thread_intro.take() {
            prompt = format!("{intro}\n\n{prompt}");
        }
        prompt
    }

    /// [`Actor::ensure_session`] for an hq agent. Whenever a session has to be created or loaded (a first message, a
    /// restart, an idle release, a new session) hq is asked again how to start the agent, so it runs as hq says now.
    pub(super) async fn ensure_hq_session(&mut self, slot: Option<&str>) -> Result<()> {
        let current = self.session_for(slot);
        if let (Some(sid), Some(conn)) = (&current, &self.conn)
            && conn.loaded.contains_key(sid)
        {
            self.turn_session = current;
            return Ok(());
        }
        if self.hub.store.kv_read(&format!("agent-env:{}", self.cfg.backend))?.is_some() {
            crate::market::vault::unlock(self.hub.clone()).await?;
        }
        self.hub.set_runtime(&self.rt, |r| r.activity = "Starting agent…".into());
        let agent = self.cfg.hq_agent.clone().ok_or_else(|| anyhow!("not an hq agent"))?;
        let Some(bin) = tokio::task::spawn_blocking(hq::bin).await? else {
            bail!("hq isn't installed on this computer (set HQ_BIN, or put `hq` on PATH)");
        };
        // The place's own folder or project, else the bot's default; hq runs in it so the kernel finds the project.
        let target = folder::resolve(&self.hub.store, &self.cfg, &self.lane_of(slot)).await;
        if let Some(notice) = &target.notice {
            self.notice(notice, NoticeStyle::Divider);
        }
        let mut launch = hq::launch(&bin, &agent, &target.cwd, &self.cfg, target.project.as_deref()).await?;
        if target.explicit {
            launch.cwd.clone_from(&target.cwd);
        }
        if self.conn.is_none() {
            let mut env = crate::agent::auth::env(&self.hub.store, &self.cfg.backend)?;
            env.extend(launch.env());
            let candidates = match std::env::var(hq::ACP_COMMAND_ENV) {
                Ok(command) if !command.is_empty() => vec![command],
                _ => {
                    let (hub, rt) = (self.hub.clone(), self.rt.clone());
                    launch_commands(&self.cfg, move |msg: &str| {
                        let msg = msg.to_owned();
                        hub.set_runtime(&rt, |r| r.activity = msg);
                    })
                    .await?
                }
            };
            let mut last_err = None;
            for (i, command) in candidates.iter().enumerate() {
                // A local CLI too old for ACP just hangs; don't make the user wait long before the fallback.
                let budget = Duration::from_secs(if i + 1 < candidates.len() { 20 } else { 180 });
                match start_agent(command, launch.cwd(&self.cfg), &env, budget).await {
                    Ok(conn) => {
                        self.conn = Some(conn);
                        break;
                    }
                    Err(e) => {
                        tracing::info!(command, error = format!("{e:#}"), "agent failed to start");
                        last_err = Some(e);
                    }
                }
            }
            if self.conn.is_none() {
                return Err(last_err.unwrap_or_else(|| anyhow!("agent failed to start")));
            }
        }
        if let Some(sid) = current {
            if self.conn.as_ref().is_some_and(|c| c.sessions.load) {
                self.hub.set_runtime(&self.rt, |r| r.activity = "Resuming session…".into());
                let res = self.session_request("session/load", launch.session_params(&self.cfg, Some(&sid))).await;
                let Some(conn) = self.conn.as_mut() else { return res.map(drop) };
                // The agent replays history as session/update before answering; drop it.
                while let Ok(inc) = conn.rx.try_recv() {
                    if let Incoming::Request { id, .. } = inc {
                        let _ = conn.acp.respond_error(id, -32601, "not supported").await;
                    }
                }
                match res {
                    Ok(res) => {
                        conn.loaded.insert(sid.clone(), Instant::now());
                        self.note_options(&sid, &res, Listing::Session);
                        self.turn_session = Some(sid);
                        return Ok(());
                    }
                    Err(e) => {
                        tracing::warn!(error = format!("{e:#}"), "session/load failed; starting fresh");
                        self.notice(
                            "Couldn't resume the previous session — starting a fresh one.",
                            NoticeStyle::Divider,
                        );
                    }
                }
            } else {
                self.notice(
                    "This agent can't resume sessions after a restart — starting a fresh one.",
                    NoticeStyle::Divider,
                );
                self.set_session(slot, None);
            }
        }
        let res = self.session_request("session/new", launch.session_params(&self.cfg, None)).await?;
        let Some(conn) = self.conn.as_mut() else { bail!("agent not running") };
        let sid = res["sessionId"].as_str().ok_or_else(|| anyhow!("agent returned no sessionId"))?.to_owned();
        conn.loaded.insert(sid.clone(), Instant::now());
        // The model was chosen by hq (`-m`), so the host doesn't set it again.
        self.note_options(&sid, &res, Listing::Session);
        self.set_session(slot, Some(&sid));
        self.session_fresh = true;
        self.turn_session = Some(sid);
        if let Some(root) = slot {
            self.thread_intro = self.thread_intro(root, false);
        }
        Ok(())
    }
}
