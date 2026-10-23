// Invites end to end against `wrangler dev`: a fake host signs requests the way the real one does, posts an invite,
// a second account (self-signed Clerk JWT, CLERK_JWT_KEY) accepts it, state shows the membership, the member asks
// for access, the host approves, and a revoke removes the membership and its grant. No real host, channels or ~/.kith.
//
//   npm run e2e:invite

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import * as ref from "../ref.ts";
import { waitFor, type Json } from "./phone.ts";

const CLOUD_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CLOUD_PORT = Number(process.env.KITH_E2E_INVITE_PORT ?? 8788);
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const ISSUER = "https://clerk.test.local"; // [env.local] CLERK_ISSUER
const WRANGLER = join(CLOUD_DIR, "node_modules/.bin/wrangler");

const tmp = mkdtempSync(join(tmpdir(), "kith-invite-e2e-"));
const persist = join(tmp, "wrangler");
const children: ChildProcess[] = [];

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
  console.log(`  ok ${what}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/-----[A-Z ]+-----|\s/g, "");

async function clerkToken(sub: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateKey.export({ format: "jwk" }), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const part = (v: unknown) => ref.b64url(ref.enc.encode(JSON.stringify(v)));
  const head = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: ISSUER, sub, sid: `sess_${sub}`, iat: now - 5, nbf: now - 5, exp: now + 3600, email: `${sub}@example.com` })}`;
  return `${head}.${ref.b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, ref.enc.encode(head))))}`;
}

/** One request; `key` adds a Kith-Sig for that key (the host's, or an account device's), `token` a Clerk session. */
async function cloud(method: string, path: string, o: { token?: string; key?: ref.SignKey; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
  const bytes = o.body === undefined ? new Uint8Array() : ref.enc.encode(JSON.stringify(o.body));
  const headers: Record<string, string> = {};
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.key) headers["Kith-Sig"] = ref.signRequest(o.key, { method, authority: `127.0.0.1:${CLOUD_PORT}`, pathAndQuery: path, body: bytes });
  const res = await fetch(CLOUD + path, { method, headers, body: bytes.length ? bytes : undefined });
  return { status: res.status, body: await res.json() };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function main() {
  const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "kith-local", "--local", "--env", "local", "--persist-to", persist], {
    cwd: CLOUD_DIR,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.stderr}`);
  const dev = spawn(WRANGLER, ["dev", "--env", "local", "--ip", "127.0.0.1", "--port", String(CLOUD_PORT), "--persist-to", persist, "--var", `CLERK_JWT_KEY:${jwtKey}`], {
    cwd: CLOUD_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  dev.stdout?.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(String(d)));
  dev.stderr?.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(String(d)));
  children.push(dev);
  await waitFor("cloud /v1/health", () => fetch(`${CLOUD}/v1/health`).then((r) => r.ok || undefined).catch(() => undefined), 60_000);

  // The fake host: registers, and its owner account claims it (signing the claim with the host key).
  const hostKey = ref.signKey();
  const hostBox = ref.boxKey();
  const computerId = ref.computerId(hostKey.pub);
  const reg = await cloud("POST", "/v1/host/register", {
    key: hostKey,
    body: { boxKey: ref.b64url(hostBox.pub), name: "Test Mac", platform: "macos", device: "e2e", version: "2.2.0" },
  });
  check(reg.status === 200 && reg.body.computerId === computerId, "the fake host registered");

  const ownerId = "user_inv_owner";
  const owner = await clerkToken(ownerId);
  const claim = await cloud("POST", "/v1/claims", { token: owner });
  const boxKey = ref.b64url(hostBox.pub);
  const sig = ref.b64url(ref.sign(hostKey, ref.enc.encode(ref.claimCanonical(claim.body.claimId, claim.body.nonce, ownerId, computerId, boxKey))));
  const done = await cloud("POST", `/v1/claims/${claim.body.claimId}/complete`, {
    token: owner,
    body: { computerId, signKey: ref.b64url(hostKey.pub), boxKey, name: "Test Mac", platform: "macos", device: "e2e", version: "2.2.0", sig },
  });
  check(done.status === 200, "the owner account claimed the fake host");

  // The host posts an invite: the cloud only gets sha256(token).
  const inviteId = `inv_${ref.b64url(ref.random(8))}`;
  const token = ref.b64url(ref.random(32));
  const posted = await cloud("POST", "/v1/host/invites", {
    key: hostKey,
    body: { inviteId, tokenHash: hex(sha256(ref.enc.encode(token))), expiresAt: Date.now() + 24 * 3600_000 },
  });
  check(posted.status === 200 && posted.body.ok === true, "the host posted an invite");

  // The friend signs in, registers a device and accepts.
  const friendId = "user_inv_friend";
  const friend = await clerkToken(friendId);
  const deviceKey = ref.signKey();
  const reged = await cloud("POST", "/v1/devices", { token: friend, key: deviceKey, body: { name: "Friend phone", platform: "ios" } });
  check(reged.status === 200, "the friend registered a device");
  check((await cloud("POST", `/v1/invites/${inviteId}/accept`, { token: friend, body: { token: "wrong" } })).status === 403, "a wrong token is refused");
  const joined = await cloud("POST", `/v1/invites/${inviteId}/accept`, { token: friend, body: { token } });
  check(joined.status === 200 && joined.body.computerId === computerId, "the friend accepted the invite");
  const membershipId = joined.body.membershipId as string;
  check((await cloud("POST", `/v1/invites/${inviteId}/accept`, { token: friend, body: { token } })).body.membershipId === membershipId, "accepting again returns the same membership");
  check((await cloud("POST", `/v1/invites/${inviteId}/accept`, { token: await clerkToken("user_inv_other"), body: { token } })).status === 409, "another account gets 409");

  let state = await cloud("GET", "/v1/host/state", { key: hostKey });
  check(
    JSON.stringify(state.body.memberships) === JSON.stringify([{ membershipId, userId: friendId, inviteId, email: `${friendId}@example.com` }]),
    "host state shows the membership",
  );
  const list = await cloud("GET", "/v1/computers", { token: friend, key: deviceKey });
  check(list.body.computers.length === 1 && list.body.computers[0].role === "member", "the friend's computer list shows the Mac as a member");

  // The member asks for access; the host approves (the 6-digit code flow, run here by the fake host).
  const nD = ref.random(32);
  const req = await cloud("POST", `/v1/computers/${computerId}/access-requests`, {
    token: friend,
    key: deviceKey,
    body: { commit: ref.b64url(ref.sasCommit(deviceKey.pub, nD)) },
  });
  check(req.status === 200, "the member created an access request");
  state = await cloud("GET", "/v1/host/state", { key: hostKey });
  check(state.body.requests[0]?.userId === friendId, "the request carries the account's user id");
  await cloud("POST", `/v1/host/access-requests/${req.body.requestId}/nonce`, { key: hostKey, body: { nonce: ref.b64url(ref.random(32)) } });
  await cloud("POST", `/v1/access-requests/${req.body.requestId}/reveal`, { token: friend, key: deviceKey, body: { nonce: ref.b64url(nD) } });
  const decision = await cloud("POST", `/v1/host/access-requests/${req.body.requestId}/decision`, { key: hostKey, body: { decision: "approve" } });
  check(decision.status === 200 && decision.body.status === "approved", "the host approved the member's device");
  state = await cloud("GET", "/v1/host/state", { key: hostKey });
  check(state.body.grants.length === 1 && state.body.grants[0].userId === friendId, "the grant names the member's user id");

  // Revoke: the membership and its grant disappear from state.
  check((await cloud("POST", `/v1/host/memberships/${membershipId}/revoke`, { key: hostKey, body: {} })).status === 200, "the host revoked the membership");
  state = await cloud("GET", "/v1/host/state", { key: hostKey });
  check(state.body.memberships.length === 0 && state.body.grants.length === 0, "state no longer shows the membership or its grant");
  check((await cloud("GET", "/v1/computers", { token: friend })).body.computers.length === 0, "the friend no longer sees the Mac");
  console.log("\ninvite e2e passed");
}

try {
  await main();
} catch (e) {
  console.error("\ninvite e2e failed:", e);
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stop));
  rmSync(tmp, { recursive: true, force: true });
}
