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

## Updates

This build never fetches releases; rebuild with `kith serve start`.

## Analytics (optional)

Usage and error events go to Kith's PostHog project (`https://us.i.posthog.com`) using a built-in
write-only public key. To send to your own project instead, set `posthog_key` in
`<data dir>/config.json` (same file as `relay_url`) or `KITH_SERVE_POSTHOG_KEY` (the env var wins).
To turn analytics off, use the analytics off switch in the app settings; nothing is sent while it is off.
Debug builds never send.
