# Codync cloud

Cloudflare Worker for accounts and the off-LAN relay (spec: [docs/reference/remote-relay.md](../docs/reference/remote-relay.md)).

- **`/v1` API** (`src/api.ts`, route groups in `src/routes/`): Clerk-authenticated account routes (devices, claims, computers, access
  requests, grants), `Kith-Sig`-authenticated host routes (the pre-rename `Codync-Sig` is still accepted) (`/v1/host/*`), the Clerk webhook, and a
  15-minute cron that expires requests and prunes nonces, and the public routine webhook route
  `POST /v1/hooks/:computerId/:routineId` (spec §7.8). D1 schema: `migrations/` (later files rebuild some tables).
- **`ComputerRelay`** (`src/relay.ts`): one Durable Object per computer (SQLite storage, WebSocket
  Hibernation). It admits device sockets against the host-signed ACL, forwards channel frames it can't
  read, reports presence, holds the offline mailbox, and queues routine webhook deliveries (`hookbox`,
  checked against the keys the host registers; `src/hooks.ts`). It is reachable only through requests the Worker
  builds itself (`X-Codync-Internal: 1`); `/internal/*` has no public route.
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

Env: `KITH_SERVE_HOST_BIN` (default `$CARGO_TARGET_DIR/debug/kith-serve`, else `../host/target/debug/kith-serve`), `CODYNC_E2E_CLOUD_PORT` (default
8787), `E2E_VERBOSE=1` to stream wrangler and host logs. Needs `python3` for the fake agent.

## Deploy

Development deployment (see [environment readiness](../docs/guides/environments-and-deployment.md); these commands change remote resources):

```bash
# Only if the database does not exist: npx wrangler d1 create codync-dev
# Confirm its database_id in [env.dev] before applying migrations.
npx wrangler d1 migrations apply codync-dev --env dev --remote
npx wrangler secret put CLERK_SECRET_KEY --env dev
npx wrangler secret put CLERK_WEBHOOK_SECRET --env dev
npx wrangler deploy --env dev               # → https://dev-api.codync.dev
```

| Name | Kind | Purpose |
|---|---|---|
| `CLERK_SECRET_KEY` | secret | JWKS for session tokens |
| `CLERK_WEBHOOK_SECRET` | secret | Svix signature on `/v1/webhooks/clerk` (`user.deleted`) |
| `CLERK_ISSUER` | var | Clerk Frontend API URL; tokens must carry this `iss` |
| `CLERK_AUTHORIZED_PARTIES` | var, optional | comma-separated; a token with `azp` must match |
| `CLERK_JWT_KEY` | var, dev/e2e only | public key for networkless verification |

### Kith

Kith runs its own copy on its own Cloudflare account, at workers.dev, without accounts: no Clerk secrets are set,
so only QR pairing admits devices (the account routes answer 401). `kith-dev` serves every local build; builds
made with `CODYNC_ENV=main` will need their own environment when we make them.

```bash
npx wrangler login                                   # once, in a browser
npx wrangler d1 create kith-dev                      # put its database_id in [env.kith-dev]
npx wrangler d1 migrations apply kith-dev --env kith-dev --remote
npx wrangler deploy --env kith-dev                   # → https://kith-cloud-dev.<account>.workers.dev
curl https://kith-cloud-dev.<account>.workers.dev/v1/health
```

The host's default for each build is in `host/src/environment.rs` (`cloud_url`); `CODYNC_CLOUD_URL` overrides it
for one host, `CODYNC_CLOUD=off` turns the cloud off. The phone learns the URL from the QR code.

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

## Remote screen relay

`POST /v1/host/screen-ice` issues one-hour Cloudflare Realtime TURN credentials to a
signed host belonging to an active account. The host first checks the calling
device's screen permission. The Worker requires `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`
(server-only secrets) and `TURN_LIMITER` (12 issuances per account per minute).
The credentials are never cached in HTTP caches or stored in D1. See
[Remote screen setup and verification](../docs/features/remote-screen.md).
