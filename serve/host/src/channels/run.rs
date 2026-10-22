//! One agent turn as a subprocess (`hq <agent> <task>`), exactly like the bridge's `run()`, and the outbox the
//! agent's `hq-send` calls leave posts in.
//!
//! Each run holds a resource-gate permit from before its process starts until it ends, so channel turns count
//! against `max_running_agents` like every other agent turn.

use super::adapter::{Adapter, Ended};
use super::core::Core;
use super::queue::kill;
use super::text::{context_pct, short};
use crate::LockExt;
use crate::agent::gate::Permit;
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt as _;

/// While a run waits for the gate, its working line says why this often.
const WAITING_EVERY: Duration = Duration::from_secs(3);

/// What a run inherits of the host's environment: the plain login basics and hq's own settings. Nothing else
/// (API keys, tokens, `KITH_*`): the bridge's runs had launchd's PATH and HOME and HQ_*, no more (KITH_* is the same settings under their new names).
fn inherited(name: &str) -> bool {
    let basic = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TZ", "TERM"].contains(&name)
        || name.starts_with("LC_");
    // No bot tokens or keys, and this is no agent's helper.
    let kith =
        ["KITH_HOME", "KITH_STATE", "KITH_MACHINE", "KITH_MODEL", "KITH_KERNEL_BIN", "KITH_KERNEL"].contains(&name);
    let hq = name.starts_with("HQ_")
        && !name.starts_with("HQ_DISCORD_")
        && !["HQ_AGENT", "HQ_PERSON", "HQ_RESUME", "HQ_BRIDGE_OUTBOX"].contains(&name);
    basic || hq || kith
}

/// Reads a pipe into a buffer that stays readable if the reader is stopped.
async fn read_into(mut pipe: impl tokio::io::AsyncRead + Unpin, into: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        into.locked().extend_from_slice(&chunk[..n]);
    }
}

fn tail(bytes: &[u8], n: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let skip = text.chars().count().saturating_sub(n);
    text.chars().skip(skip).collect()
}

impl Core {
    /// Waits for the gate's permit, with the working line saying why it waits. None: stopped while waiting.
    pub(super) async fn admit(&self, ad: &Arc<dyn Adapter>, wk: &str, cancel: &tokio::sync::Notify) -> Option<Permit> {
        let mut admission = self.gate.enter(&format!("channels:{wk}"));
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
    }

    /// One agent turn in this thread. The permit is held until it ends.
    pub(super) async fn run(
        &self,
        ad: &Arc<dyn Adapter>,
        key: &str,
        agent: &str,
        wk: &str,
        task: &str,
        _permit: Permit,
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
            std::env::vars_os().filter(|(k, _)| k.to_str().is_some_and(inherited)).collect();
        // Both spellings of a kernel setting: the kernel reads KITH_<X>, role repos written before the rename HQ_<X>.
        let mut set = |name: &str, v: &str| {
            for (k, v) in crate::kernel::both(name, v) {
                env.push((k.into(), v.into()));
            }
        };
        set("VIA", ad.platform());
        set("OUTPUT", "json");
        if let Some(mode) = &self.settings.permission_mode {
            set("PERMISSION_MODE", mode); // unset: the agent's mode, else hq's default
        }
        if !owner {
            set("PERSON", &person); // bin/hq checks the membership again and sets their mode
        }
        if let Some(session) = &session {
            set("RESUME", session); // any harness: bin/hq starts a new session when this one is another harness's
        }
        let outbox = self.paths.data.join("outbox").join(short(&format!("{wk}{}", super::core::now())));
        std::fs::create_dir_all(&outbox).with_context(|| format!("creating {}", outbox.display()))?;
        set("BRIDGE_OUTBOX", &outbox.to_string_lossy());
        for (k, v) in ad.env(&conv, agent) {
            env.push((k.into(), v.into())); // already under both spellings
        }
        if let Some(ended) = self.with(|i| i.busy.get(wk).and_then(|b| b.ended)) {
            let _ = std::fs::remove_dir(&outbox);
            return Ok(ended); // stopped before the process existed
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
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            if let Some(pid) = pid {
                kill(pid);
            }
            let _ = std::fs::remove_dir(&outbox);
            anyhow::bail!("no pipes on the agent process");
        };
        let (out, err) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        let readers = [tokio::spawn(read_into(stdout, out.clone())), tokio::spawn(read_into(stderr, err.clone()))];
        let stop_pump = Arc::new(tokio::sync::Notify::new());
        let pump = {
            let (poll, ad, conv, outbox, stop) =
                (self.settings.poll, ad.clone(), conv.clone(), outbox.clone(), stop_pump.clone());
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        () = tokio::time::sleep(poll) => flush(&ad, &conv, &outbox).await,
                        () = stop.notified() => break,
                    }
                }
            })
        };
        // One budget for the process and for its output: an agent that leaves a background process holding the
        // pipes open can't hang the turn.
        let grace = self.settings.reader_grace;
        let finished = async {
            let _ = child.wait().await;
            self.with(|i| i.busy.get_mut(wk).map(|b| b.exited = true));
            let [out_reader, err_reader] = readers;
            tokio::time::timeout(grace, async {
                let _ = tokio::join!(out_reader, err_reader);
            })
            .await
            .is_ok()
        };
        let outcome = tokio::time::timeout(self.settings.run_timeout, finished).await;
        let timed_out = outcome.is_err();
        if timed_out || matches!(outcome, Ok(false)) {
            // Out of time, or output still open after the process left: whatever is left of its group goes too.
            if let Some(pid) = pid {
                kill(pid);
            }
            self.with(|i| i.busy.get_mut(wk).map(|b| b.exited = true));
        }
        stop_pump.notify_one();
        let _ = pump.await; // a post in flight finishes before the last flush
        flush(ad, &conv, &outbox).await;
        let _ = std::fs::remove_dir(&outbox);
        if let Some(ended) = self.with(|i| i.busy.get(wk).and_then(|b| b.ended)) {
            return Ok(ended);
        }
        let (out, err) = if timed_out {
            (Vec::new(), b"timed out after 60 min".to_vec())
        } else {
            (out.locked().clone(), err.locked().clone())
        };

        let (text, sid, pct) = if let Ok(res) = serde_json::from_slice::<Value>(&out) {
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
            let who = item.get("as").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("kith");
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
                tracing::warn!("{}: kith-send post failed: {e:#}", ad.conn());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::inherited;

    #[test]
    fn runs_get_the_login_basics_and_hq_settings_only() {
        for name in [
            "PATH",
            "HOME",
            "USER",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "TZ",
            "TERM",
            "HQ_HOME",
            "HQ_MODEL",
            "HQ_BIN",
            "KITH_HOME",
            "KITH_MODEL",
            "KITH_KERNEL_BIN",
        ] {
            assert!(inherited(name), "{name} should reach a run");
        }
        for name in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "OPENAI_API_KEY",
            "KITH_SERVE_HOME",
            "JEV_API_KEY",
            "TELEGRAM_BOT_TOKEN",
            "SLACK_APP_TOKEN",
            "DISCORD_BOT_TOKEN",
            "HQ_DISCORD_BOT_TOKEN",
            "KITH_DISCORD_BOT_TOKEN",
            "KITH_AGENT",
            "KITH_PERSON",
            "KITH_BRIDGE_OUTBOX",
            "HQ_AGENT",
            "HQ_PERSON",
            "HQ_RESUME",
            "HQ_BRIDGE_OUTBOX",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!inherited(name), "{name} must not reach a run");
        }
    }
}
