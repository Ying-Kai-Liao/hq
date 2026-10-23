# Kith cloud

Cloudflare Worker for accounts and the off-LAN relay (spec: [docs/reference/remote-relay.md](../docs/reference/remote-relay.md)).

- **`/v1` API** (`src/api.ts`, route groups in `src/routes/`): Clerk-authenticated account routes (devices, claims, computers, access
  requests, grants), `Kith-Sig`-authenticated host routes (`/v1/host/*`), the Clerk webhook, and a
  15-minute cron that expires requests and prunes nonces, and the public routine webhook route
  `POST /v1/hooks/:computerId/:routineId` (spec §7.8). D1 schema: `migrations/` (later files rebuild some tables).
- **`ComputerRelay`** (`src/relay.ts`): one Durable Object per computer (SQLite storage, WebSocket
  Hibernation). It admits device sockets against the host-signed ACL, forwards channel frames it can't
  read, reports presence, holds the offline mailbox, and queues routine webhook deliveries (`hookbox`,
  checked against the keys the host registers; `src/hooks.ts`). It is reachable only through requests the Worker
  builds itself (`X-Kith-Internal: 1`); `/internal/*` has no public route.
- **Auth** (`src/auth.ts`): Clerk session JWTs via `@clerk/backend` (`CLERK_SECRET_KEY` → JWKS fetched and
  cached per isolate; `CLERK_JWT_KEY` → networkless, dev/e2e only) and Ed25519 request signatures
  (WebCrypto).

The channel relay sees ciphertext and routing metadata. The account API also stores account/device metadata. It can shorten access (revoke, block) but never grant
it: new devices come from the host's own QR pairing or its approval, and the ACL is signed by the host.

## Test

```bash
npm ci
npm run typecheck
npm test          # vitest in workerd: vectors, Kith-Sig, API, DO relay/mailbox
```

`test/ref.ts` is a device/host reference implementation on `@noble/*`, checked against
`docs/reference/fixtures/remote-relay-vectors.json` and reused by the relay tests and the e2e harness.

The vitest pool's bundled workerd may trail wrangler's; `vitest.config.ts` pins the test compatibility
date to the newest one it supports. `wrangler.toml` keeps the deploy date.

### End to end (spec §12.1)

```bash
(cd ../host && cargo build)
npm run e2e       # local D1 + wrangler dev + real kith-serve + test/e2e/phone.ts
```

Env: `KITH_SERVE_HOST_BIN` (default `$CARGO_TARGET_DIR/debug/kith-serve`, else `../host/target/debug/kith-serve`), `KITH_E2E_CLOUD_PORT` (default
8787), `E2E_VERBOSE=1` to stream wrangler and host logs. Needs `python3` for the fake agent.

## Deploy

Deploys go through the `kith-dev` and `kith` environments (see Kith below). The top level of `wrangler.toml` is only what the tests and `wrangler dev` run on (a local D1, no routes, no Clerk instance), so always pass `--env`; `--env local` is for `wrangler dev` and the e2e harness.

| Name | Kind | Purpose |
|---|---|---|
| `CLERK_SECRET_KEY` | secret | JWKS for session tokens |
| `CLERK_WEBHOOK_SECRET` | secret | Svix signature on `/v1/webhooks/clerk` (`user.deleted`) |
| `CLERK_ISSUER` | var | Clerk Frontend API URL; tokens must carry this `iss` |
| `CLERK_AUTHORIZED_PARTIES` | var, optional | comma-separated; a token with `azp` must match |
| `CLERK_JWT_KEY` | var, dev/e2e only | public key for networkless verification |

### Kith

Kith runs its own copy on its own Cloudflare account, at workers.dev, without accounts: no Clerk secrets are set,
so only QR pairing admits devices (the account routes answer 401). `kith-dev` serves every local build; release
builds use the `kith` environment (below).

```bash
npx wrangler login                                   # once, in a browser
npx wrangler d1 create kith-dev                      # put its database_id in [env.kith-dev]
npx wrangler d1 migrations apply kith-dev --env kith-dev --remote
npx wrangler deploy --env kith-dev                   # → https://kith-cloud-dev.<account>.workers.dev
curl https://kith-cloud-dev.<account>.workers.dev/v1/health
```

The host's default for each build is in `host/src/environment.rs` (`cloud_url`); `KITH_SERVE_CLOUD_URL` overrides it
for one host, `KITH_SERVE_CLOUD=off` turns the cloud off. The phone learns the URL from the QR code.

### Kith accounts (the `kith` environment)

Sign-in with Google, Apple and GitHub, claiming a Mac to an account, and the account becoming the owner person's
`kith` handle in kith-auth (`kith-auth who kith <clerk user id>`). Steps marked **[Kai]** need your Clerk, Apple or
Cloudflare login; the rest are one-line commands. Nothing secret goes in the repo.

1. **[Kai]** Clerk dashboard (https://dashboard.clerk.com) > Create application > name it `Kith` > turn on Google, Apple and GitHub > Create.
   (Apple needs your Apple Developer Services ID, team id and key: Clerk's SSO connections page walks through it.
   Google and GitHub work with Clerk's development credentials until you want your own.)
2. **[Kai]** Clerk > API keys: copy the **Publishable key** (`pk_...`) and the **Frontend API URL** (the issuer, `https://<name>.clerk.accounts.dev`, or your own domain). Copy the **Secret key** (`sk_...`) too, for step 6.
3. Put the issuer in `wrangler.toml`: `[env.kith]` > `vars` > `CLERK_ISSUER` (replace `https://clerk.invalid`).
4. `npx wrangler login` (once, in a browser) **[Kai]**
5. `npx wrangler d1 create kith`, then put the `database_id` it prints into `[env.kith]` > `d1_databases` (replace the `0000...` placeholder).
6. `npx wrangler secret put CLERK_SECRET_KEY --env kith` (paste the `sk_...` key when asked) **[Kai]**
7. **[Kai]** Clerk > Webhooks > Add endpoint: `https://kith-cloud.<your-account>.workers.dev/v1/webhooks/clerk`, event `user.deleted`. Copy the **Signing secret** (`whsec_...`), then `npx wrangler secret put CLERK_WEBHOOK_SECRET --env kith`. (Deploy once first, step 9, to learn the URL; set the webhook and this secret after.)
8. `npx wrangler d1 migrations apply kith --env kith --remote`
9. `npx wrangler deploy --env kith`, then `curl https://kith-cloud.<your-account>.workers.dev/v1/health`
10. App builds: set `KITH_CLERK_PUBLISHABLE_KEY=pk_...` and `KITH_CLOUD_URL=https://kith-cloud.<your-account>.workers.dev` in the environment when you build the desktop and iOS apps (the apps pick them up at build time; see `apps/README.md`).
11. On each Mac, keep a kith-auth owner person (`kith-auth person <you> owner`). When the Mac is claimed, the host binds `kith <clerk user id>` to that person; leaving the account removes it. The Settings "Link Telegram" button asks the host for `linkCode`.

The rule stays: the cloud can only shorten a device's access, never grant it; the host decides.

Local end-to-end of the account path (no Clerk account needed, a self-signed test key):

```bash
(cd ../host && cargo build --bin kith-serve)
npm run e2e:account   # local D1 + wrangler dev + real kith-serve in a temp home + a throwaway kith-auth
```

New computers are limited to 10 per IP per minute with the Workers Rate Limiting binding
`REGISTER_LIMITER` (`[[ratelimits]]`; each environment needs its own `namespace_id`).
Public routine webhook deliveries are limited to 60 per sender IP and hook per minute with
`HOOK_LIMITER` (same binding kind, its own `namespace_id` per environment).

## Invites and memberships

The Mac invites a friend; the cloud only records who accepted, and can only remove access. The Mac binds the account
to a kith-auth person and decides the role. Link: `kith://invite?c=<computerId>&i=<inviteId>&t=<token>` (token = 32 random
bytes, base64url; the cloud sees only its sha256 hex). D1: `invites` and `memberships` (`migrations/0005_invites.sql`), at
most one active membership per (computer, account).

Host-signed (`Kith-Sig`, like the other `/v1/host/*` routes; each writes an `audit_events` row):

- `POST /v1/host/invites` `{inviteId, tokenHash, expiresAt}` (ms, at most 48 h ahead): stores the invite. Re-posting the same
  id and hash is a no-op; the same id with another hash is 409. The computer must be claimed.
- `POST /v1/host/invites/:inviteId/revoke`: marks an unaccepted invite revoked (409 once accepted; use the membership).
- `POST /v1/host/memberships/:membershipId/revoke`: ends the membership and revokes that account's grants on the computer.
- `GET /v1/host/state` adds `memberships: [{membershipId, userId, inviteId, email}]` (active only), `userId` on each grant (the
  account owning the device) and on each access request.

Account (Clerk):

- `POST /v1/invites/:inviteId/accept` `{token}`: creates the membership and returns `{computerId, membershipId}`. The same
  account repeating it gets the same membership. 403 wrong token or the computer's owner, 404 unknown invite, 409 used by
  another account (or already a member), 410 expired (`inviteExpired`) or revoked (`inviteRevoked`). Races have one winner.
- `GET /v1/computers` also lists computers where the account is a member; each row has `role: "owner" | "member"`.
- `POST /v1/computers/:id/access-requests` is open to a member as well as the owner. The host approves it; the cloud never
  does. Members cannot rename, remove or list grants of the computer.

Unclaiming a computer and the Clerk `user.deleted` webhook revoke the affected memberships and unused invites.
`npm run e2e:invite` runs the flow against `wrangler dev` with a fake host.

## Bot guests

A cloud agent (Grok Bot and the like) joins a Mac with a link and has no Clerk account: the bot is a device with its own
Ed25519 key, tied to one person on the Mac. Design and threat model: `docs/kith-bot-guests.md`. Same direction of trust as
invites: the cloud only records accepts and can only remove access; the Mac decides who the bot is and what it may do. The
invite token `t` never reaches the cloud. The bot sends `sha256hex(t)` to accept and the cloud stores
`sha256hex(sha256hex(t))` (the host keeps `sha256hex(t)` and checks `t` itself). D1: `bot_invites` and `bot_devices`
(`migrations/0006_bot_guests.sql`). Limits: 50 active bot devices and 100 open invites per computer; accepts are limited to 10
per IP per minute with `BOT_JOIN_LIMITER` (own `namespace_id` per environment). `audit_events` gets `botinvite.create`,
`botinvite.revoke`, `botinvite.accept` and `botdevice.revoke`. The cron sweep deletes unaccepted bot invites 7 days after they expire.

Host-signed:

- `POST /v1/host/bot-invites` `{inviteId, tokenHash, expiresAt}` (ms, at most 48 h ahead): same rules as `/v1/host/invites`
  (re-post is a no-op, same id with another hash is 409), but no claim is needed; 409 `tooMany` over 100 open invites.
- `POST /v1/host/bot-invites/:inviteId/revoke`: marks an unaccepted invite revoked (409 once accepted; revoke the device).
- `POST /v1/host/bot-devices/:botDeviceId/revoke`: sets `revoked_at`, blocks the key in the relay DO with grant id
  `bot:<botDeviceId>` (closing its sockets with 4003) and audits. Repeating it re-sends the block.
- `GET /v1/host/state` adds `botDevices: [{botDeviceId, inviteId, deviceKey, name, provider, createdAt}]` (active only).

Bot-signed (`Kith-Sig` by the bot's own key, replay checked by `sig_nonces`):

- `POST /v1/bot-invites/:inviteId/accept` `{token: "<sha256hex(t)>", name, provider?}` returns `{computerId, botDeviceId}`.
  The same key repeating it gets the same device. 403 wrong proof, 404 unknown invite, 409 `inviteUsed` (another key got
  there first), 409 `conflict` (this key already has a bot here) or `tooMany`, 410 `inviteExpired` or `inviteRevoked`
  (also for a device that was revoked), 429 `rateLimited`. Races have one winner. A successful accept makes the DO send
  `cloud.changed` to the host, which pulls `botDevices`.

Relay: the host lists a bot in the signed ACL as `{dk, grant: "bot:<id>", kind: "bot"}` (`kind` is optional and must be
`"bot"` when present). A bot socket counts against `MAX_BOT_SOCKETS = 8` per computer and 2 per key, apart from the 16 human
sockets, is limited to 60 messages and 1 MiB per 10 s (humans: 200 and 8 MiB), gets `mbox.err {code: "notAllowed"}` for any
mailbox message (an offline Mac fails fast), and can never use a pairing offer. A socket whose ACL kind changes is closed 4003.
`npm run e2e:bot` runs the flow against `wrangler dev` with a fake host.

## Remote screen relay

`POST /v1/host/screen-ice` issues one-hour Cloudflare Realtime TURN credentials to a
signed host belonging to an active account. The host first checks the calling
device's screen permission. The Worker requires `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`
(server-only secrets) and `TURN_LIMITER` (12 issuances per account per minute).
The credentials are never cached in HTTP caches or stored in D1. See
[Remote screen setup and verification](../docs/features/remote-screen.md).
