// Bot guests end to end against `wrangler dev`: a fake host registers, connects its relay socket and posts a bot invite
// (the cloud only gets sha256hex(sha256hex(t))); a fake bot, with its own key and no account, accepts it; the host hears
// `cloud.changed`, pulls `botDevices`, publishes an ACL that lists the bot with kind "bot"; the bot connects, is refused
// a mailbox, and loses its socket when the host revokes the device. No real host, channels or ~/.kith.
//
//   npm run e2e:bot

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import * as ref from "../ref.ts";
import { waitFor, Wire, type Json } from "./phone.ts";

const CLOUD_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CLOUD_PORT = Number(process.env.KITH_E2E_BOT_PORT ?? 8789);
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const WS = `ws://127.0.0.1:${CLOUD_PORT}`;
const WRANGLER = join(CLOUD_DIR, "node_modules/.bin/wrangler");

const tmp = mkdtempSync(join(tmpdir(), "kith-bot-e2e-"));
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

/** One signed request; `key` is the host's or the bot's. */
async function cloud(method: string, path: string, o: { key?: ref.SignKey; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
  const bytes = o.body === undefined ? new Uint8Array() : ref.enc.encode(JSON.stringify(o.body));
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.key) headers["Kith-Sig"] = ref.signRequest(o.key, { method, authority: `127.0.0.1:${CLOUD_PORT}`, pathAndQuery: path, body: bytes });
  const res = await fetch(CLOUD + path, { method, headers, body: bytes.length ? bytes : undefined });
  return { status: res.status, body: await res.json() };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The link's secret t, what the bot sends (sha256hex(t)) and what the host posts (sha256hex of that). */
function secrets() {
  const proof = hex(sha256(ref.enc.encode(ref.b64url(ref.random(32)))));
  return { proof, tokenHash: hex(sha256(ref.enc.encode(proof))) };
}

async function main() {
  const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "kith-local", "--local", "--env", "local", "--persist-to", persist], {
    cwd: CLOUD_DIR,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.stderr}`);
  const dev = spawn(WRANGLER, ["dev", "--env", "local", "--ip", "127.0.0.1", "--port", String(CLOUD_PORT), "--persist-to", persist], {
    cwd: CLOUD_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  dev.stdout?.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(String(d)));
  dev.stderr?.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(String(d)));
  children.push(dev);
  await waitFor("cloud /v1/health", () => fetch(`${CLOUD}/v1/health`).then((r) => r.ok || undefined).catch(() => undefined), 60_000);

  // The fake host: registered, relay socket up with an empty ACL, ready.
  const hostKey = ref.signKey();
  const hostBox = ref.boxKey();
  const computerId = ref.computerId(hostKey.pub);
  const reg = await cloud("POST", "/v1/host/register", {
    key: hostKey,
    body: { boxKey: ref.b64url(hostBox.pub), name: "Test Mac", platform: "macos", device: "e2e", version: "0.1.0" },
  });
  check(reg.status === 200 && reg.body.computerId === computerId, "the fake host registered");
  let ver = 0;
  const publish = async (host: Wire, devices: { dk: string; grant: string | null; kind?: "bot" }[]) => {
    ver += 1;
    host.send(ref.aclMessage(hostKey, { v: 1, computerId, ver, devices, offers: [] }));
    await host.next((m) => m.t === "acl.ok" && m.ver === ver, `acl.ok ${ver}`);
  };
  const host = Wire.connect(`${WS}/v1/relay/host?v=1`, hostKey);
  await host.opened;
  await publish(host, []);
  host.send({ t: "ready" });

  // The host posts the invite. It is not claimed by any account.
  const inviteId = `binv_${ref.b64url(ref.random(8))}`;
  const s = secrets();
  const posted = await cloud("POST", "/v1/host/bot-invites", {
    key: hostKey,
    body: { inviteId, tokenHash: s.tokenHash, expiresAt: Date.now() + 24 * 3600_000 },
  });
  check(posted.status === 200 && posted.body.ok === true, "the host posted a bot invite for an unclaimed computer");

  // The bot, with no account, accepts. A wrong proof is refused first.
  const botKey = ref.signKey();
  const botDk = ref.b64url(botKey.pub);
  const wrong = await cloud("POST", `/v1/bot-invites/${inviteId}/accept`, { key: botKey, body: { token: secrets().proof, name: "Rex", provider: "grok" } });
  check(wrong.status === 403, "a wrong proof gets 403");
  const joined = await cloud("POST", `/v1/bot-invites/${inviteId}/accept`, { key: botKey, body: { token: s.proof, name: "Rex", provider: "grok" } });
  check(joined.status === 200 && joined.body.computerId === computerId && /^bd_/.test(joined.body.botDeviceId), "the bot accepted the invite");
  const botDeviceId: string = joined.body.botDeviceId;
  check((await cloud("POST", `/v1/bot-invites/${inviteId}/accept`, { key: botKey, body: { token: s.proof, name: "Rex" } })).body.botDeviceId === botDeviceId, "accepting again returns the same device");
  check((await cloud("POST", `/v1/bot-invites/${inviteId}/accept`, { key: ref.signKey(), body: { token: s.proof, name: "Other" } })).status === 409, "another key gets 409");
  await host.next((m) => m.t === "cloud.changed", "cloud.changed after the accept");
  console.log("  ok the host heard cloud.changed");

  // The host pulls state and decides: it lists the bot in the ACL, with kind "bot".
  const state = await cloud("GET", "/v1/host/state", { key: hostKey });
  check(
    JSON.stringify(state.body.botDevices.map((d: Json) => [d.botDeviceId, d.inviteId, d.deviceKey, d.name, d.provider])) ===
      JSON.stringify([[botDeviceId, inviteId, botDk, "Rex", "grok"]]),
    "host state lists the bot device",
  );
  const before = Wire.connect(`${WS}/v1/relay/device/${computerId}?v=1`, botKey);
  await before.opened.then(
    () => { throw new Error("a bot not in the ACL was admitted"); },
    () => undefined,
  );
  console.log("  ok a bot that is not in the ACL is refused");
  await publish(host, [{ dk: botDk, grant: `bot:${botDeviceId}`, kind: "bot" }]);

  const bot = Wire.connect(`${WS}/v1/relay/device/${computerId}?v=1`, botKey);
  await bot.opened;
  const open = await host.next((m) => m.t === "open" && m.dk === botDk, "open for the bot");
  const presence = await bot.next((m) => m.t === "presence", "presence");
  check(presence.online === true, "the bot connected and sees the host online");
  bot.send({ t: "hello", n: 1 });
  const data = await host.next((m) => m.t === "data" && m.link === open.link, "the bot's frame at the host");
  check(data.m.n === 1, "frames reach the host");
  bot.send({ t: "mbox.put", nonce: "n1", d: ref.b64url(ref.random(200)) });
  check((await bot.next((m) => m.t === "mbox.err", "mbox.err")).code === "notAllowed", "a bot gets no mailbox");

  // Revoke: the socket closes 4003, state forgets the bot, and a reconnect is refused.
  check((await cloud("POST", `/v1/host/bot-devices/${botDeviceId}/revoke`, { key: hostKey, body: {} })).status === 200, "the host revoked the bot device");
  check((await bot.closed()) === 4003, "the bot's socket closed 4003");
  check((await cloud("GET", "/v1/host/state", { key: hostKey })).body.botDevices.length === 0, "state no longer lists the bot");
  const after = Wire.connect(`${WS}/v1/relay/device/${computerId}?v=1`, botKey);
  await after.opened.then(
    () => { throw new Error("a revoked bot reconnected"); },
    () => undefined,
  );
  console.log("  ok the revoked bot cannot reconnect");
  const gone = await cloud("POST", `/v1/bot-invites/${inviteId}/accept`, { key: botKey, body: { token: s.proof, name: "Rex" } });
  check(gone.status === 410, "the used invite does not bring the bot back");

  // An unused invite can be revoked too.
  const spare = `binv_${ref.b64url(ref.random(8))}`;
  const t = secrets();
  await cloud("POST", "/v1/host/bot-invites", { key: hostKey, body: { inviteId: spare, tokenHash: t.tokenHash, expiresAt: Date.now() + 3600_000 } });
  check((await cloud("POST", `/v1/host/bot-invites/${spare}/revoke`, { key: hostKey, body: {} })).status === 200, "the host revoked an unused invite");
  check((await cloud("POST", `/v1/bot-invites/${spare}/accept`, { key: ref.signKey(), body: { token: t.proof, name: "Late" } })).status === 410, "a revoked invite answers 410");
  host.ws.close();
  console.log("\nbot e2e passed");
}

try {
  await main();
} catch (e) {
  console.error("\nbot e2e failed:", e);
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stop));
  rmSync(tmp, { recursive: true, force: true });
}
