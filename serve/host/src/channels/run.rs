//! One agent turn as a subprocess (`hq <agent> <task>`), exactly like the bridge's `run()`, and the outbox the
//! agent's `hq-send` calls leave posts in.
//!
//! Each run holds a resource-gate permit from before its process starts until it ends, so channel turns count
//! against `max_running_agents` like every other agent turn.

use super::adapter::{Adapter, Ended};
use super::core::Core;
use super::queue::kill;
use super::text::{context_pct, short};
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt as _;

/// While a run waits for the gate, its working line says why this often.
const WAITING_EVERY: Duration = Duration::from_secs(3);

/// Environment a run must not inherit: bot tokens and keys, and this is no agent's helper.
fn withheld(name: &str) -> bool {
    ["JEV_", "TELEGRAM_", "SLACK_", "DISCORD_", "HQ_DISCORD_"].iter().any(|p| name.starts_with(p))
        || ["HQ_AGENT", "HQ_PERSON", "HQ_RESUME", "HQ_BRIDGE_OUTBOX"].contains(&name)
}

async fn read_all(mut pipe: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = pipe.read_to_end(&mut out).await;
    out
}

fn tail(bytes: &[u8], n: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let skip = text.chars().count().saturating_sub(n);
    text.chars().skip(skip).collect()
}

impl Core {
    /// One agent turn in this thread.
    pub(super) async fn run(
        &self,
        ad: &Arc<dyn Adapter>,
        key: &str,
        agent: &str,
        wk: &str,
        task: &str,
    ) -> Result<Ended> {
        let (conv, person, session) = self.with(|i| {
            let th = i.st.threads.get(key);
            let get = |k: &str| th.and_then(|t| t.get(k));
            (
                get("conv").cloned().unwrap_or(Value::Null),
                get("person").and_then(Value::as_str).unwrap_or("").to_owned(),
                get("sessions").and_then(|s| s.get(agent)).and_then(Value::as_str).map(str::to_owned),
            )
        });
        let owner = if person.is_empty() { true } else { super::hq::resolve(&self.paths, &person, agent).await.owner };
        let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> =
            std::env::vars_os().filter(|(k, _)| !k.to_str().is_some_and(withheld)).collect();
        let mut set = |k: &str, v: &str| env.push((k.into(), v.into()));
        set("HQ_VIA", ad.platform());
        set("HQ_OUTPUT", "json");
        if let Some(mode) = &self.settings.permission_mode {
            set("HQ_PERMISSION_MODE", mode); // unset: the agent's mode, else hq's default
        }
        if !owner {
            set("HQ_PERSON", &person); // bin/hq checks the membership again and sets their mode
        }
        if let Some(session) = &session {
            set("HQ_RESUME", session); // any harness: bin/hq starts a new session when this one is another harness's
        }
        let outbox = self.paths.data.join("outbox").join(short(&format!("{wk}{}", super::core::now())));
        std::fs::create_dir_all(&outbox).with_context(|| format!("creating {}", outbox.display()))?;
        set("HQ_BRIDGE_OUTBOX", &outbox.to_string_lossy());
        for (k, v) in ad.env(&conv, agent) {
            set(&k, &v);
        }

        let cancel = self.with(|i| i.busy.get(wk).map(|b| b.cancel.clone())).unwrap_or_default();
        let mut admission = self.gate.enter(&format!("channels:{wk}"));
        let permit = {
            let waiting = async {
                loop {
                    tokio::select! {
                        permit = admission.granted() => break permit,
                        () = tokio::time::sleep(WAITING_EVERY) => {
                            let status = self.with(|i| i.busy.get(wk).map(|b| b.status.clone()));
                            if let Some(status) = status.filter(|s| !s.is_null()) {
                                ad.status_text(&status, &self.gate.waiting_text()).await;
                            }
                        }
                    }
                }
            };
            tokio::select! {
                permit = waiting => Some(permit),
                () = cancel.notified() => None,
            }
        };
        let ended = self.with(|i| i.busy.get(wk).and_then(|b| b.ended));
        let Some(_permit) = permit else {
            let _ = std::fs::remove_dir(&outbox);
            return Ok(ended.unwrap_or(Ended::Stopped));
        };
        if let Some(ended) = ended {
            let _ = std::fs::remove_dir(&outbox);
            return Ok(ended); // stopped while it waited for room
        }

        let mut cmd = tokio::process::Command::new(&self.paths.hq_bin);
        cmd.arg(agent)
            .arg(format!("{task}{}", ad.footer()))
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                let _ = std::fs::remove_dir(&outbox);
                let text = format!("⚠️ {agent} failed:\n```\n{e}\n```");
                self.say(ad, &conv, agent, &text, None).await;
                return Ok(Ended::Done);
            }
        };
        let pid = child.id();
        let stop_now = self.with(|i| {
            let b = i.busy.get_mut(wk)?;
            b.pid = pid;
            b.ended.is_some().then_some(())
        });
        if stop_now.is_some()
            && let Some(pid) = pid
        {
            kill(pid); // Stop was pressed before the process existed
        }
        let (stdout, stderr) = (child.stdout.take().context("stdout")?, child.stderr.take().context("stderr")?);
        let (out_task, err_task) = (tokio::spawn(read_all(stdout)), tokio::spawn(read_all(stderr)));
        let pump = {
            let (poll, ad, conv, outbox) = (self.settings.poll, ad.clone(), conv.clone(), outbox.clone());
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(poll).await;
                    flush(&ad, &conv, &outbox).await;
                }
            })
        };
        let timed_out = tokio::time::timeout(self.settings.run_timeout, child.wait()).await.is_err();
        if timed_out && let Some(pid) = pid {
            kill(pid);
        }
        self.with(|i| i.busy.get_mut(wk).map(|b| b.exited = true));
        let (out, err) = if timed_out {
            out_task.abort();
            err_task.abort();
            (Vec::new(), b"timed out after 60 min".to_vec())
        } else {
            (out_task.await.unwrap_or_default(), err_task.await.unwrap_or_default())
        };
        pump.abort();
        flush(ad, &conv, &outbox).await;
        let _ = std::fs::remove_dir(&outbox);
        if let Some(ended) = self.with(|i| i.busy.get(wk).and_then(|b| b.ended)) {
            return Ok(ended);
        }

        let (text, sid, pct) = if let Ok(res) = serde_json::from_slice::<Value>(&out) {
            {
                let mut text = res.get("result").and_then(Value::as_str).unwrap_or("").to_owned();
                if res.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                    let why = if text.is_empty() {
                        res.get("subtype").and_then(Value::as_str).unwrap_or("error").to_owned()
                    } else {
                        text
                    };
                    text = format!("⚠️ {why}");
                }
                let sid = res.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
                (text, sid, context_pct(&res))
            }
        } else {
            let shown = tail(if err.is_empty() { &out } else { &err }, 1500);
            (format!("⚠️ {agent} failed:\n```\n{shown}\n```"), None, None)
        };
        if let Some(sid) = sid {
            self.with(|i| {
                if let Some(th) = i.st.threads.get_mut(key) {
                    th["sessions"][agent] = Value::String(sid);
                    i.save();
                }
            });
        }
        let show = pct.filter(|p| self.settings.context_show.is_some_and(|min| *p >= min));
        self.say(ad, &conv, agent, &text, show).await;
        Ok(Ended::Done)
    }

    async fn say(&self, ad: &Arc<dyn Adapter>, conv: &Value, agent: &str, text: &str, ctx: Option<f64>) {
        if let Err(e) = ad.post(conv, agent, text, ctx).await {
            tracing::warn!("{}: posting {agent}'s answer failed: {e:#}", ad.conn());
        }
    }
}

/// Posts what the run's hq-send calls left in its outbox, oldest first.
pub(super) async fn flush(ad: &Arc<dyn Adapter>, conv: &Value, outbox: &Path) {
    {
        let Ok(entries) = std::fs::read_dir(outbox) else { return };
        let mut files: Vec<_> =
            entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        for f in files {
            let Some(item) = std::fs::read(&f).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
                continue;
            };
            if std::fs::remove_file(&f).is_err() {
                continue;
            }
            let who = item.get("as").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("hq");
            let files: Vec<String> = item
                .get("files")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            let sent = if files.is_empty() {
                ad.post(conv, who, item.get("text").and_then(Value::as_str).unwrap_or(""), None).await
            } else {
                ad.send_files(conv, who, &files, item.get("caption").and_then(Value::as_str).unwrap_or("")).await
            };
            if let Err(e) = sent {
                // One failed post must not end the run's other posts.
                tracing::warn!("{}: hq-send post failed: {e:#}", ad.conn());
            }
        }
    }
}
