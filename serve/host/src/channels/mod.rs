//! Chat channels: the routing core of hq's chat bridge (`kernel/lib/hq_bridge/core.py`) inside the host, with no
//! platform of its own. Discord, Telegram and Slack plug in as [`Adapter`]s; each is cut over from the Python
//! bridge on its own (grant its profile to the client `serve` in hq-auth, revoke it from `bridge`).
//!
//! What it does for a message, whatever the platform: finds the person (`hq-auth who`, `/link CODE` to link an
//! account), picks the agent (`@agent`, the thread's last agent, the room's default, or asks "who should take
//! this?"), keeps a thread per task with a session per agent, queues messages sent while the agent works (merging
//! them, and with Jev stopping, restarting or splitting the work), and runs each turn as a subprocess
//! `hq <agent> <task>` under the resource gate. Agents' own posts (`hq-send`) reach the thread through the run's
//! outbox folder (`HQ_BRIDGE_OUTBOX`), a live agent's (`hq-send --to bridge:<box>`) through
//! `~/.hq/bridge/outbox/live-<box>/`.
//!
//! Cutting a bot over from the bridge: `hq-auth grant serve <platform> <profile>`, then
//! `hq-auth revoke bridge <platform>`. The bridge reads its grants only when it starts, so restart it
//! after the revoke (`launchctl kickstart -k gui/$UID/dev.hq.bridge`) or both answer. The router needs the Jev
//! key too: `hq-auth grant serve jev-browser <profile>`, or every message sent while an agent works is merged.
//!
//! State: `<data dir>/channels/state.json` (the bridge's v2 schema), run outboxes and attachments next to it. The
//! first time a connection starts here its entries are copied from the bridge's `~/.hq/bridge/state.json`, which
//! is only read.
//!
//! Settings: the `channels` object in `<data dir>/config.json`, read at start:
//! `enabled` (default true), `dm_default` (the agent the owner's new DMs go to, default `personal`),
//! `debounce_s` (seconds to wait for more messages before a run starts, default 2), `router` (`jev` or `off`,
//! default `jev` when a Jev key is found), `interrupt` (false: corrections wait for the next turn instead of
//! restarting the run, default true), `context_show` (a reply ends with a "context N%" line once the session is at
//! least this full, default 30, `"off"` never), `permission_mode` (the owner's runs; unset leaves it to the agent's
//! settings and hq's default), `discord_guild` (server name or id for the Discord adapter).
//!
//! Connections: for each of discord, telegram and slack, the profiles `hq-auth granted --for serve <platform>`
//! lists; their secrets come from `hq-auth get --for serve --profile <p> <platform> <VAR>` and are never logged.

#![allow(dead_code)] // the adapters (next packages) use what is not called yet

mod adapter;
mod core;
mod hq;
mod judge;
mod manager;
mod queue;
mod run;
mod settings;
mod state;
mod telegram;
mod text;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

#[allow(unused_imports)]
pub use adapter::{Adapter, Alive, Constructor, Ended, Fut, Incoming, Reaction, Secrets, StopPress};
pub use core::Core;
#[allow(unused_imports)]
pub use manager::Registry;
pub use manager::status;

use crate::hub::Hub;
use std::sync::Arc;

/// Starts the channels in the background: nothing happens without hq, or with `channels.enabled` off.
pub fn start(hub: &Arc<Hub>) {
    tokio::spawn(run(hub.clone()));
}

async fn run(hub: Arc<Hub>) {
    let settings = settings::Settings::load();
    if !settings.enabled {
        tracing::info!("channels are off (channels.enabled in config.json)");
        return;
    }
    let Some(paths) = tokio::task::spawn_blocking(hq::Paths::discover).await.ok().flatten() else {
        tracing::info!("channels: no hq found; chat channels are off");
        return;
    };
    let judge = judge::Judge::from_hub(hub.clone(), paths.clone());
    let core = Core::new(core::Deps { paths, settings, gate: hub.gate.clone(), judge });
    manager::Manager::new(core, Registry::builtin(), manager::Backoff::default()).run().await;
}
