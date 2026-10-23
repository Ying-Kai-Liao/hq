// Accounts end to end: the real kith-serve against `wrangler dev`. A test user signs in (a self-signed Clerk JWT,
// CLERK_JWT_KEY), claims a throwaway host, and the owner person in a throwaway kith-auth gets the `kith <user id>`
// handle; `linkCode` answers; leaving the account removes the handle. No channels run (temporary KITH_SERVE_HOME),
// ~/.kith is never read (KITH_AUTH points into the temp folder).
//
//   npm run e2e:account     after `cargo build --bin kith-serve` in host/ (or set KITH_SERVE_HOST_BIN)

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ref from "../ref.ts";
import { waitFor, type Json } from "./phone.ts";

const CLOUD_DIR = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = join(CLOUD_DIR, "..");
const KERNEL_BIN = join(ROOT, "..", "kernel/bin");
const HOST_BIN = process.env.KITH_SERVE_HOST_BIN ?? join(resolve(join(ROOT, "host"), process.env.CARGO_TARGET_DIR ?? "target"), "debug/kith-serve");
const CLOUD_PORT = Number(process.env.KITH_E2E_CLOUD_PORT ?? 8787);
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const ISSUER = "https://clerk.test.local"; // [env.local] CLERK_ISSUER
const WRANGLER = join(CLOUD_DIR, "node_modules/.bin/wrangler");

const tmp = mkdtempSync(join(tmpdir(), "kith-account-e2e-"));
const persist = join(tmp, "wrangler");
const home = join(tmp, "home");
const authFile = join(tmp, "auth.json");
const children: ChildProcess[] = [];

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
  console.log(`  ok ${what}`);
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(cmd, args, { cwd: CLOUD_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(String(d)));
  child.stderr?.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(String(d)));
  children.push(child);
  return child;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

/** kith-auth against the throwaway auth.json. */
const kithAuth = (...args: string[]) => spawnSync("python3", [join(KERNEL_BIN, "kith-auth"), ...args], { encoding: "utf8", env: { ...process.env, KITH_AUTH: authFile } });
const who = (uid: string): Json => JSON.parse(kithAuth("who", "kith", uid).stdout);

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/-----[A-Z ]+-----|\s/g, "");

async function clerkToken(sub: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateKey.export({ format: "jwk" }), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const part = (v: unknown) => ref.b64url(ref.enc.encode(JSON.stringify(v)));
  const head = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: ISSUER, sub, sid: `sess_${sub}`, iat: now - 5, nbf: now - 5, exp: now + 3600, email: `${sub}@example.com` })}`;
  return `${head}.${ref.b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, ref.enc.encode(head))))}`;
}

async function cloud(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(CLOUD + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: res.status, body: await res.json() };
}

let hostPort = 0;

async function loopback(method: string, body: unknown = {}): Promise<Json> {
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${hostPort}/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const v = await res.json();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${JSON.stringify(v)}`);
  return v;
}

async function main() {
  const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "kith-local", "--local", "--env", "local", "--persist-to", persist], {
    cwd: CLOUD_DIR,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.stderr}`);
  run(WRANGLER, ["dev", "--env", "local", "--ip", "127.0.0.1", "--port", String(CLOUD_PORT), "--persist-to", persist, "--var", `CLERK_JWT_KEY:${jwtKey}`]);
  await waitFor("cloud /v1/health", () => fetch(`${CLOUD}/v1/health`).then((r) => r.ok || undefined).catch(() => undefined), 60_000);

  check(kithAuth("person", "kai", "owner").status === 0, "owner person kai exists in the throwaway kith-auth");
  hostPort = await freePort();
  run(HOST_BIN, ["serve", "--port", String(hostPort)], {
    KITH_SERVE_HOME: home,
    KITH_SERVE_CLOUD_URL: CLOUD,
    KITH_AUTH: authFile,
    KITH_KERNEL_BIN: join(KERNEL_BIN, "kith"),
  });
  await waitFor("host /health", () => fetch(`http://127.0.0.1:${hostPort}/health`).then((r) => r.ok || undefined).catch(() => undefined), 30_000);
  const computerId = (await (await fetch(`http://127.0.0.1:${hostPort}/health`)).json()).computerId as string;
  check(Boolean(computerId), "the test host has a computer id");
  const unclaimedLink = await fetch(`http://127.0.0.1:${hostPort}/api/linkCode`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readFileSync(join(home, "token"), "utf8").trim()}`, "Content-Type": "application/json" },
    body: "{}",
  });
  check(unclaimedLink.ok, "linkCode answers before any account (owner person exists)");
  check(who("user_e2e").person === null, "no kith handle before the claim");

  const userId = "user_e2e";
  const token = await clerkToken(userId);
  const claim = await cloud("POST", "/v1/claims", { token });
  const signed = await loopback("claimSign", { claimId: claim.body.claimId, nonce: claim.body.nonce, userId });
  const done = await cloud("POST", `/v1/claims/${claim.body.claimId}/complete`, { token, body: signed });
  check(done.status === 200 && done.body.computer.computerId === computerId, "the signed-in test user claimed the host");

  await waitFor("owner person gets the kith handle", () => who(userId).person === "kai" || undefined);
  check(who(userId).owner === true, `kith-auth who kith ${userId} returns the owner`);
  const link = await loopback("linkCode");
  check(/^[A-Z2-9]{6}$/.test(link.code) && link.expiresAt > Date.now(), `linkCode returns a code (${link.code}) and an expiry`);

  await loopback("unclaim");
  await waitFor("handle removed after leaving the account", () => who(userId).person === null || undefined);
  check(who(userId).owner_id === "kai", "the owner person stays after the handle goes");
  console.log("\naccount e2e passed");
}

try {
  if (spawnSync(HOST_BIN, ["--version"]).error) throw new Error(`kith-serve not found at ${HOST_BIN}; run \`cargo build --bin kith-serve\` in host/ or set KITH_SERVE_HOST_BIN`);
  await main();
} catch (e) {
  console.error("\naccount e2e failed:", e);
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stop));
  rmSync(tmp, { recursive: true, force: true });
}
