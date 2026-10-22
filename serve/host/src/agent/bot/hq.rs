//! The sessions of an hq agent's bot: `hq <agent> --launch-json` says how to start it (see `agent::hq`), and
//! nothing of Kith's goes in with it — no instructions of its own, no `chat`/`memory`/`team`/`routines` servers,
//! no memory snapshot, no dreaming. The agent's reply is its turn's text.

use super::fast_mode::Listing;
use super::launch::{launch_commands, start_agent};
use super::{Actor, NoticeStyle};
use crate::agent::acp::Incoming;
use crate::agent::backups::{ChainEntry, NoAccount, Pick};
use crate::agent::{folder, hq};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::{Duration, Instant};

impl Actor {
    pub(super) fn is_hq(&self) -> bool {
        self.cfg.is_hq()
    }

    /// What the prompt of an hq bot's turn is: the user's words, with the notes the host owes the agent (an earlier
    /// conversation's handoff, where a thread branches off). Nothing about Kith.
    pub(super) fn compose_hq(&mut self, text: &str) -> String {
        self.session_fresh = false;
        // The turn goes to the next account as the first one got it, handoff and thread notes included.
        let mut prompt = if self.reuse_prompt {
            self.thread_intro = None;
            self.attempt_prompt.clone().unwrap_or_else(|| text.to_owned())
        } else {
            let mut prompt = text.to_owned();
            if let Some(handoff) = self.handoff.take() {
                prompt = format!("{handoff}\n\n{prompt}");
            }
            if let Some(intro) = self.thread_intro.take() {
                prompt = format!("{intro}\n\n{prompt}");
            }
            self.attempt_prompt = Some(prompt.clone());
            prompt
        };
        if let Some(preface) = self.preface.take() {
            prompt = format!("{preface}\n\n{prompt}");
        }
        prompt
    }

    /// The session `slot` has on the account that answers now: the agent's stored one, or the one a backup entry
    /// opened in this process.
    fn hq_session(&mut self, slot: Option<&str>) -> Option<String> {
        match self.serving.clone() {
            None => self.session_for(slot),
            Some(entry) => self.backup_sessions.get(&(entry, slot.unwrap_or_default().to_owned())).cloned(),
        }
    }

    fn hq_set_session(&mut self, slot: Option<&str>, sid: &str) {
        match self.serving.clone() {
            None => self.set_session(slot, Some(sid)),
            Some(entry) => {
                self.backup_sessions.insert((entry, slot.unwrap_or_default().to_owned()), sid.to_owned());
            }
        }
    }

    /// The agent's backup chain, as hq said it within the last half minute. None, or any failure, is an empty chain.
    async fn hq_chain(&self, agent: &str) -> Vec<ChainEntry> {
        if let Some(chain) = self.hub.backups.fresh_chain(agent) {
            return chain;
        }
        let chain = match tokio::task::spawn_blocking(hq::bin).await {
            Ok(Some(bin)) => hq::backups(&bin, agent).await.unwrap_or_else(|error| {
                tracing::debug!(agent, error = format!("{error:#}"), "no backup chain");
                Vec::new()
            }),
            _ => Vec::new(),
        };
        self.hub.backups.set_chain(agent, chain.clone());
        chain
    }

    /// `session/new` and `session/load` for `launch`: Claude's `_meta` for Claude, ACP's own parameters for a Codex
    /// backup (its servers as a list, the instructions as `systemPrompt` when it takes them).
    fn hq_params(&self, launch: &hq::Launch, session: Option<&str>) -> Value {
        if !launch.is_codex() {
            return launch.session_params(&self.cfg, session);
        }
        let servers: Vec<Value> = launch
            .mcp_servers
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, s)| {
                let env: Vec<Value> =
                    s["env"].as_object().into_iter().flatten().map(|(k, v)| json!({"name": k, "value": v})).collect();
                json!({"name": name, "command": s["command"], "args": s["args"], "env": env})
            })
            .collect();
        let mut params = json!({"cwd": launch.cwd(&self.cfg), "mcpServers": servers});
        if let Some(sid) = session {
            params["sessionId"] = sid.into();
        }
        let caps = self.conn.as_ref().map(|c| c.sessions);
        if caps.is_some_and(|c| c.additional_directories) && !launch.add_dirs.is_empty() {
            params["additionalDirectories"] = json!(launch.add_dirs);
        }
        if caps.is_some_and(|c| c.system_prompt) && !launch.system_prompt.is_empty() {
            params["systemPrompt"] = super::system_prompt(&launch.system_prompt);
        }
        params
    }

    /// [`Actor::ensure_session`] for an hq agent. Whenever a session has to be created or loaded (a first message, a
    /// restart, an idle release, a new session) hq is asked again how to start the agent, so it runs as hq says now.
    ///
    /// Which account answers is decided here, once per turn (see `agent::backups`): the first entry of the agent's
    /// chain that is ready and not out of usage. A turn already running is never moved.
    pub(super) async fn ensure_hq_session(&mut self, slot: Option<&str>) -> Result<()> {
        let agent = self.cfg.hq_agent.clone().ok_or_else(|| anyhow!("not an hq agent"))?;
        let chain = self.hq_chain(&agent).await;
        let mut skip: HashSet<String> = self.turn_tried.clone();
        let mut prepared = None;
        let (mut launch, backup) = loop {
            let backup = match self.hub.backups.pick(&agent, &chain, &skip) {
                Pick::Primary => None,
                Pick::Backup(entry) => Some(entry.id),
                Pick::AllOut(outs) => return Err(NoAccount(self.hub.backups.all_out_text(&outs)).into()),
            };
            self.serving.clone_from(&backup);
            let current = self.hq_session(slot);
            if let (Some(sid), Some(conn)) = (&current, &self.conn)
                && conn.loaded.contains_key(sid)
                && self.conn_serving == self.serving
            {
                self.turn_session = current;
                return Ok(());
            }
            if prepared.is_none() {
                if self.hub.store.kv_read(&format!("agent-env:{}", self.cfg.backend))?.is_some() {
                    crate::market::vault::unlock(self.hub.clone()).await?;
                }
                self.hub.set_runtime(&self.rt, |r| r.activity = "Starting agent…".into());
                let Some(bin) = tokio::task::spawn_blocking(hq::bin).await? else {
                    bail!("kith isn't installed on this computer (set KITH_KERNEL_BIN, or put `kith` on PATH)");
                };
                // The place's own folder or project, else the bot's default; hq runs in it so the kernel finds the project.
                let target = folder::resolve(&self.hub.store, &self.cfg, &self.lane_of(slot)).await;
                if let Some(notice) = &target.notice {
                    self.notice(notice, NoticeStyle::Divider);
                }
                prepared = Some((bin, target));
            }
            let Some((bin, target)) = &prepared else { unreachable!("prepared above") };
            match hq::launch(bin, &agent, &target.cwd, &self.cfg, target.project.as_deref(), backup.as_deref()).await {
                Ok(mut launch) => {
                    if target.explicit {
                        launch.cwd.clone_from(&target.cwd);
                    }
                    break (launch, backup);
                }
                // hq won't run this entry (not signed in, not allowed for this person): the next one answers.
                Err(error) if backup.is_some() => {
                    let id = backup.unwrap_or_default();
                    tracing::info!(entry = %id, error = format!("{error:#}"), "backup account skipped");
                    self.hub.backups.note_unavailable(&agent, &id);
                    skip.insert(id);
                }
                Err(error) => return Err(error),
            }
        };
        // A backup has no session of the agent's to load: it starts one and is told the conversation.
        let current = self.hq_session(slot).filter(|_| backup.is_none());
        // The process carries kith's env (KITH_PROJECT, the cost tag) and its folder: a place that needs others gets a
        // process of its own, started again here (the sessions it held load again on their next turn).
        let started_as = (launch.env(), launch.cwd(&self.cfg).to_owned());
        if self.conn.is_some()
            && (self.conn_started_as.as_ref() != Some(&started_as) || self.conn_serving != self.serving)
            && let Some(c) = self.conn.take()
        {
            c.acp.kill().await;
        }
        if self.conn.is_none() {
            self.conn_started_as = Some(started_as);
            self.conn_serving.clone_from(&self.serving);
            let provider = if launch.is_codex() { "codex" } else { self.cfg.backend.as_str() };
            let mut env = crate::agent::auth::env(&self.hub.store, provider)?;
            env.extend(launch.env());
            let candidates = match std::env::var(hq::ACP_COMMAND_ENV) {
                Ok(command) if !command.is_empty() => vec![command],
                _ => {
                    let (hub, rt) = (self.hub.clone(), self.rt.clone());
                    // A Codex backup starts Codex's adapter, not the bot's own.
                    let mut cfg = self.cfg.clone();
                    if launch.is_codex() {
                        cfg.backend = "codex".into();
                        cfg.command = None;
                    }
                    launch_commands(&cfg, move |msg: &str| {
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
                let params = self.hq_params(&launch, Some(&sid));
                let res = self.session_request("session/load", params).await;
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
                        // The agent's own account came back to a session that missed what a backup answered.
                        self.preface = self.recovery_preface();
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
        let params = self.hq_params(&launch, None);
        let res = self.session_request("session/new", params).await?;
        let Some(conn) = self.conn.as_mut() else { bail!("agent not running") };
        let sid = res["sessionId"].as_str().ok_or_else(|| anyhow!("agent returned no sessionId"))?.to_owned();
        conn.loaded.insert(sid.clone(), Instant::now());
        // The model was chosen by hq (`-m`), so the host doesn't set it again.
        self.note_options(&sid, &res, Listing::Session);
        self.hq_set_session(slot, &sid);
        self.session_fresh = true;
        self.turn_session = Some(sid);
        if backup.is_some() {
            self.preface = self.backup_preface();
            // Codex takes the agent's instructions as ACP's `systemPrompt`; one that can't gets them first.
            if launch.is_codex()
                && !self.conn.as_ref().is_some_and(|c| c.sessions.system_prompt)
                && !launch.system_prompt.is_empty()
            {
                let prompt = std::mem::take(&mut launch.system_prompt);
                let profile = format!("<agent-profile>\n{prompt}\n</agent-profile>");
                self.preface = Some(match self.preface.take() {
                    Some(preface) => format!("{profile}\n\n{preface}"),
                    None => profile,
                });
            }
        } else {
            self.preface = self.recovery_preface();
        }
        if let Some(root) = slot {
            self.thread_intro = self.thread_intro(root, false);
        }
        Ok(())
    }
}
