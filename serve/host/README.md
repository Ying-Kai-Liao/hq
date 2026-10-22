# kith-serve

Kith's host: runs coding-agent bots over ACP and serves the Kith apps. Built on
[Codync](https://github.com/leepokai/Codync) (Apache-2.0); see `../NOTICE` and `LICENSE`.

## One `kith` binary

The crate builds the same program under two names: `kith` and `kith-serve` (the name the launchd job and the apps
use). As `kith`, `kith serve <install|stop|status|...>` runs the host, `kith --version` prints the version, and any other
command (`kith <agent>`, `kith doctor`, `kith serve start|restart|relay`) is exec'd to the kernel's `bin/hq` with the
same arguments (`src/kernel.rs`: the one place that names the entry point and the lookup: `$KITH_KERNEL`, then
`../share/kith/kernel` beside the real binary, then `~/hq/kernel`). As `kith-serve` the host never looks for a kernel.
`kith serve start` on a packaged install copies the `kith` binary to `~/.kith/serve/bin/kith-serve`.
Releases (`.github/workflows/release.yml`, `scripts/package-release.sh`) pack `bin/kith` with the kernel.

## Cloud relay (optional)

A Dev build uses Kai's public relay unless told otherwise; a Main build has none. To reach this
computer from outside the local network through another relay (the Worker in `../cloud`), set one in
one of two ways, highest precedence first:

1. `KITH_SERVE_CLOUD_URL=https://relay.example.workers.dev`
2. `<data dir>/config.json` (`~/.kith/serve/config.json`):

   ```json
   { "relay_url": "https://relay.example.workers.dev" }
   ```

`KITH_SERVE_CLOUD=off` (or the cloud switched off in the app) wins over both. A missing, empty or
invalid file means the build's default: the Dev relay on a Dev build, none on Main (the cloud stays off
and the status says no relay URL is set).

## Launcher (macOS)

launchd credits file access to the program it starts. To let the host read folders on an external
volume (hq's agents), run it behind a launcher that has Full Disk Access: set `"launcher": [...]` in
`config.json` or `KITH_SERVE_LAUNCHER='[...]'` when installing. By default the job runs the host
directly. Set `launcher` if your agents live on an external volume, e.g.
`["~/.hq/bin/hq-uv", "run", "--quiet", "--script", "<repo>/kernel/bin/kith-serve-launch"]` (full paths).

With a launcher, `kernel/bin/kith-serve-launch` passes SIGTERM/SIGINT/SIGHUP to the host and SIGKILLs it if it
hasn't exited 20 s later (`KITH_SERVE_KILL_GRACE_S`), so a hung host can't keep `host.lock` through a restart.

## Watchdog

`kith serve` checks itself every 15 s: a task proves the async runtime and its blocking pool still answer. If
that stops for `watchdog_stall_s` (default 180, at least 30) the host logs an error and exits with code 70, and launchd's
`KeepAlive` starts a new one. Set `watchdog_stall_s` in `config.json` or `KITH_SERVE_WATCHDOG_STALL_S` (the
variable wins); `0` or `off` disables it. Read at start. Sleep doesn't count (the clock stops while the Mac
sleeps). The job has no `ThrottleInterval`, so launchd's 10 s default applies to the restart.

## Resource limits

The host runs at most a few agent turns at once and holds a turn back while the computer is short
of memory. A turn is any work that prompts an agent (a message, a routine, a room turn, a bot
request); one that waits shows "Waiting for room (2 agents running)" or "Waiting for room (memory
18% free)" as the bot's activity, and starts when a slot frees up, in the order bots began waiting.
When memory is what blocks, agents at rest (nothing running or queued, sessions they can load
again) are stopped first, longest idle first. A turn that waits on another bot's reply gives its
slot to that bot meanwhile; a turn waiting for you to answer a permission card keeps its slot.

Set these in `<data dir>/config.json` (same file as `relay_url`) or with the environment (the
variable wins). They are read at start; restart to change them. A value that isn't valid is logged
and the default is used.

| config.json key | environment variable | default | meaning |
| --- | --- | --- | --- |
| `max_running_agents` | `KITH_SERVE_MAX_RUNNING_AGENTS` | 2 | turns at once, at least 1 |
| `min_free_memory_percent` | `KITH_SERVE_MIN_FREE_MEMORY_PERCENT` | 25 | wait while available memory is below this; 0 turns the check off |
| `max_swap_used_gb` | `KITH_SERVE_MAX_SWAP_USED_GB` | 3 | wait while swap in use is above this; 0 turns the check off |
| `idle_shutdown_minutes` | `KITH_SERVE_IDLE_SHUTDOWN_MINUTES` | 10 | an unused agent stops after this long (it loads its session again on the next message), at least 1 |

Available memory is `kern.memorystatus_level` on macOS (the "free percentage" `memory_pressure`
prints) and `MemAvailable` on Linux; a platform or read error counts as room. `GET /health` has a
`gate` object with the running and waiting counts, the limits and the latest reading.

## Chat channels (Discord, Telegram, Slack)

The host carries the routing core of hq's chat bridge (`src/channels/`): people, `@agent`, threads and
sessions, the queue with Jev routing, `hq <agent>` runs under the resource gate, live agents and the
`hq-send` outbox. The platform adapters plug into it one at a time; until one is ported its bots stay with
the Python bridge. A bot is cut over by revoking its profile from `bridge` and restarting the bridge
(`launchctl kickstart -k gui/$UID/dev.hq.bridge`; it reads its grants only at start), and only then granting
it to the client `serve` in hq-auth: grants are checked every minute, and the first time a connection starts
here its rooms, threads, last message seen and queued messages are copied from `~/.hq/bridge/state.json` (read
only), which must happen after the bridge stopped handling messages. State lives in
`<data dir>/channels/state.json`. Also grant `jev-browser` to `serve` too or the router merges
every message sent while an agent works. `GET /health` has a `channels` object with each connection's state.

**Telegram** (`src/channels/telegram/`) is ported: grant `telegram` profiles to `serve`
(`hq-auth grant serve telegram <profile>`, secret `TELEGRAM_BOT_TOKEN`) and revoke them from `bridge`. It long-polls
`getUpdates` and keeps the offset in the connection's state (the same key the bridge used, so imported state
continues where the bridge stopped). While the bridge still polls the same bot Telegram answers 409; the host
logs that, waits (30 s, doubling to 2 min) and keeps trying, so revoke the bridge's grant and restart it to end the
overlap. Answers are Markdown shown as Telegram HTML, sent plain if Telegram refuses the formatting. The Bot API
address is `https://api.telegram.org`, or `KITH_TELEGRAM_API` (a local Bot API server; tests use a fake).

**Slack** (`src/channels/slack/`) is ported: grant `slack` profiles to `serve` (`hq-auth grant serve slack <profile>`,
secrets `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`) and revoke them from `bridge`. It runs in Socket Mode (no public
URL): `apps.connections.open` with the app token, a websocket, every envelope acknowledged on arrival and handled
after. A task is a Slack thread; `@agent` as plain text picks the agent, mentioning the app or a DM addresses hq,
commands start with `!` (`!link CODE`, `!agents`, `!default`, `!stop`, `!whoami`). Agents post under their display
name (needs `chat:write.customize`). The app needs bot scopes `app_mentions:read`, `channels:history`,
`groups:history`, `im:history`, `chat:write`, `chat:write.customize`, `files:read`, `files:write`,
`reactions:write`, events `message.channels`, `message.groups`, `message.im` and `app_mention`, Interactivity on
(the Stop and pick buttons) and Socket Mode on. The Web API address is `https://slack.com/api`, or `KITH_SLACK_API`
(tests use a fake).

The `channels` object in `config.json` (read at start):

| key | default | meaning |
| --- | --- | --- |
| `enabled` | true | false turns channels off |
| `dm_default` | `personal` | the agent the owner's new DMs go to |
| `debounce_s` | 2 | seconds a run waits for more messages |
| `router` | `jev` | `off` merges every message sent while an agent works |
| `interrupt` | true | false makes corrections wait for the next turn |
| `context_show` | 30 | a reply ends with "context N%" from this fullness; `"off"` never |
| `permission_mode` | unset | the owner's runs; unset leaves it to the agent, then hq |
| `discord_guild` | unset | server name or id when the Discord bot is in several |

### Discord

`src/channels/discord/` (hand-rolled gateway and REST, no Discord crate) does what the bridge's
`discord_chat.py` did, in one server: an `hq` category with a channel per agent (created, and its topic
kept at the agent's description, within a minute of a new agent), a mentionable `@agent` role per agent when
the bot has Manage Roles (plain `@agent` otherwise), a thread per task opened from the message, answers
posted through the channel's webhook under the agent's display name (webhooks are kept in the connection's
state, so the bridge's are reused), a `-# working…` line with a Stop button, "Who should take this?" buttons,
DMs, attachments saved under `<data dir>/channels/attachments/`, and a read-back of what was sent since the
last message seen (at most 24 h, once) after every new gateway session. `hq-send` keeps posting into the
thread through `HQ_DISCORD_WEBHOOK_URL` and `HQ_DISCORD_THREAD_ID`. Grant it with
`hq-auth grant serve discord <profile>` (secret `DISCORD_BOT_TOKEN`); no restart is needed. The bot needs the
Message Content intent. For tests, `HQ_DISCORD_API_BASE` and `HQ_DISCORD_GATEWAY_URL` move both addresses.

## Updates

This build never fetches releases; rebuild with `kith serve start`.

## Analytics (optional)

Usage and error events go to Kith's PostHog project (`https://us.i.posthog.com`) using a built-in
write-only public key. To send to your own project instead, set `posthog_key` in
`<data dir>/config.json` (same file as `relay_url`) or `KITH_SERVE_POSTHOG_KEY` (the env var wins).
To turn analytics off, use the analytics off switch in the app settings; nothing is sent while it is off.
Debug builds never send.
