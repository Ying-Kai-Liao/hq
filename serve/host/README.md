# kith-serve

Kith's host: runs coding-agent bots over ACP and serves the Kith apps. Built on
[Codync](https://github.com/leepokai/Codync) (Apache-2.0); see `../NOTICE` and `LICENSE`.

## Cloud relay (optional)

No cloud is built in. To reach this computer from outside the local network, point the host at a
relay (the Worker in `../cloud`) in one of two ways, highest precedence first:

1. `KITH_SERVE_CLOUD_URL=https://relay.example.workers.dev`
2. `<data dir>/config.json` (`~/.kith/serve/config.json`):

   ```json
   { "relay_url": "https://relay.example.workers.dev" }
   ```

`KITH_SERVE_CLOUD=off` (or the cloud switched off in the app) wins over both. A missing, empty or
invalid file means no relay: the cloud stays off and the status says no relay URL is set.

## Updates

This build never fetches releases; rebuild with `kith serve start`.

## Analytics (optional)

Usage and error events go to a PostHog project only when its write-only key is set:
`posthog_key` in `<data dir>/config.json` (same file as `relay_url`), or `KITH_SERVE_POSTHOG_KEY`.
No key, no network call. The host is `https://us.i.posthog.com`.
