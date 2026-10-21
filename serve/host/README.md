# kith-serve

Kith's host: runs coding-agent bots over ACP and serves the Kith apps. Built on
[Codync](https://github.com/leepokai/Codync) (Apache-2.0); see `../NOTICE` and `LICENSE`.

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
the Python bridge. A bot is cut over by granting its profile to the client `serve` in hq-auth and revoking
it from `bridge`: grants are checked every minute, and the first time a connection starts here its rooms,
threads and queued messages are copied from `~/.hq/bridge/state.json` (read only). State lives in
`<data dir>/channels/state.json`. The bridge reads its grants only at start, so restart it after revoking
(`launchctl kickstart -k gui/$UID/dev.hq.bridge`), and grant `jev-browser` to `serve` too or the router merges
every message sent while an agent works. `GET /health` has a `channels` object with each connection's state.

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

## Updates

This build never fetches releases; rebuild with `kith serve start`.

## Analytics (optional)

Usage and error events go to Kith's PostHog project (`https://us.i.posthog.com`) using a built-in
write-only public key. To send to your own project instead, set `posthog_key` in
`<data dir>/config.json` (same file as `relay_url`) or `KITH_SERVE_POSTHOG_KEY` (the env var wins).
To turn analytics off, use the analytics off switch in the app settings; nothing is sent while it is off.
Debug builds never send.
