// Bot guests: the host posts a bot invite, the bot's own key accepts it, the host reads the bot device from state and can
// revoke it; the relay admits a bot under its own caps and never gives it a mailbox.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { sweep } from "../src/api";
import { parseAcl } from "../src/relay";
import { call, devicePath, env, hostSocket, newHost, socket, upgrade, type Json, type TestHost } from "./helpers";
import * as ref from "./ref";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const dkOf = (k: ref.SignKey) => ref.b64url(k.pub);

/** The link's secret `t`, what the bot sends (sha256hex(t)) and what the host posts to the cloud (sha256hex of that). */
function secrets() {
  const t = ref.b64url(ref.random(32));
  const proof = hex(sha256(ref.enc.encode(t)));
  return { proof, tokenHash: hex(sha256(ref.enc.encode(proof))) };
}

async function invite(host: TestHost, o: { ttl?: number } = {}) {
  const inviteId = `binv_${ref.b64url(ref.random(8))}`;
  const s = secrets();
  const r = await call("POST", "/v1/host/bot-invites", {
    key: host.sign,
    body: { inviteId, tokenHash: s.tokenHash, expiresAt: Date.now() + (o.ttl ?? 24 * 3600_000) },
  });
  expect(r).toEqual({ status: 200, body: { ok: true } });
  return { inviteId, ...s };
}

const accept = (bot: ref.SignKey, inviteId: string, token: string, o: { name?: string; ip?: string; nonce?: string } = {}) =>
  call("POST", `/v1/bot-invites/${inviteId}/accept`, {
    key: bot,
    nonce: o.nonce,
    headers: o.ip ? { "CF-Connecting-IP": o.ip } : undefined,
    body: { token, name: o.name ?? "Rex", provider: "grok" },
  });

const state = async (host: TestHost) => (await call("GET", "/v1/host/state", { key: host.sign })).body as Json;
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

/** A host and an invite ready to accept, no claim needed. */
async function setup() {
  const host = await newHost();
  return { host, ...(await invite(host)) };
}

describe("host bot invites", () => {
  it("stores an invite for an unclaimed computer, treats a re-post as a no-op, and refuses a clash", async () => {
    const { host, inviteId, tokenHash } = await setup();
    const exp = Date.now() + 3600_000;
    expect((await call("POST", "/v1/host/bot-invites", { key: host.sign, body: { inviteId, tokenHash, expiresAt: exp } })).status).toBe(200);
    const other = hex(sha256(ref.enc.encode("x")));
    expect((await call("POST", "/v1/host/bot-invites", { key: host.sign, body: { inviteId, tokenHash: other, expiresAt: exp } })).status).toBe(409);
    // Another computer can't take the id either.
    const stranger = await newHost();
    expect((await call("POST", "/v1/host/bot-invites", { key: stranger.sign, body: { inviteId, tokenHash, expiresAt: exp } })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM bot_invites WHERE invite_id = ?", inviteId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'botinvite.create' AND target = ?", inviteId)).toBe(1);
  });

  it("validates the body and needs a signed, registered host", async () => {
    const { host, tokenHash } = await setup();
    const post = (b: Json) => call("POST", "/v1/host/bot-invites", { key: host.sign, body: b });
    const ok = { inviteId: "binv_ok", tokenHash, expiresAt: Date.now() + 3600_000 };
    expect((await post({ ...ok, tokenHash: "nothex" })).status).toBe(400);
    expect((await post({ ...ok, inviteId: "bad id!" })).status).toBe(400);
    expect((await post({ ...ok, expiresAt: Date.now() - 1 })).status).toBe(400);
    expect((await post({ ...ok, expiresAt: Date.now() + 30 * 86_400_000 })).status).toBe(400);
    expect((await post({ ...ok, expiresAt: "soon" })).status).toBe(400);
    expect((await call("POST", "/v1/host/bot-invites", { body: ok })).status).toBe(401);
    expect((await call("POST", "/v1/host/bot-invites", { key: ref.signKey(), body: ok })).status).toBe(404);
  });

  it("allows at most 100 open invites per computer", async () => {
    const host = await newHost();
    const { tokenHash } = secrets();
    const post = (i: number) =>
      call("POST", "/v1/host/bot-invites", { key: host.sign, body: { inviteId: `many_${i}`, tokenHash, expiresAt: Date.now() + 3600_000 } });
    // 99 rows straight into D1 (each API call is slow under load); the 100th and 101st go through the route.
    await env.DB.batch(
      Array.from({ length: 99 }, (_, i) =>
        env.DB.prepare("INSERT INTO bot_invites(invite_id, computer_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(
          `many_${i}`,
          host.cid,
          tokenHash,
          Date.now() + 3600_000,
          Date.now(),
        ),
      ),
    );
    expect((await post(99)).status).toBe(200);
    const over = await post(100);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("tooMany");
    // A re-post of one that exists still answers ok.
    expect((await post(7)).status).toBe(200);
    // Revoking one frees a place.
    expect((await call("POST", "/v1/host/bot-invites/many_3/revoke", { key: host.sign, body: {} })).status).toBe(200);
    expect((await post(100)).status).toBe(200);
  });

  it("revokes an unaccepted invite, once, and not one that was accepted or belongs to another host", async () => {
    const { host, inviteId, proof } = await setup();
    const stranger = await newHost();
    const path = `/v1/host/bot-invites/${inviteId}/revoke`;
    expect((await call("POST", path, { key: stranger.sign, body: {} })).status).toBe(404);
    expect((await call("POST", path, { key: host.sign, body: {} })).body).toEqual({ ok: true });
    expect((await call("POST", path, { key: host.sign, body: {} })).status).toBe(200);
    const r = await accept(ref.signKey(), inviteId, proof);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("inviteRevoked");
    const used = await invite(host);
    expect((await accept(ref.signKey(), used.inviteId, used.proof)).status).toBe(200);
    expect((await call("POST", `/v1/host/bot-invites/${used.inviteId}/revoke`, { key: host.sign, body: {} })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'botinvite.revoke' AND target = ?", inviteId)).toBe(1);
  });
});

describe("accepting a bot invite", () => {
  it("makes a bot device the host sees, and the same key accepting again gets the same one", async () => {
    const { host, inviteId, proof } = await setup();
    const bot = ref.signKey();
    const first = await accept(bot, inviteId, proof);
    expect(first.status).toBe(200);
    expect(first.body.computerId).toBe(host.cid);
    expect(first.body.botDeviceId).toMatch(/^bd_/);
    const again = await accept(bot, inviteId, proof, { name: "Renamed" });
    expect(again.body).toEqual(first.body);
    const s = await state(host);
    expect(s.botDevices).toEqual([
      { botDeviceId: first.body.botDeviceId, inviteId, deviceKey: dkOf(bot), name: "Rex", provider: "grok", createdAt: expect.any(Number) },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'botinvite.accept' AND target = ?", inviteId)).toBe(1);
    // The bot is not a Clerk device, grant or member.
    expect(s.grants).toEqual([]);
    expect(s.memberships).toEqual([]);
  });

  it("tells the host's socket to pull state", async () => {
    const { host, inviteId, proof } = await setup();
    const hostWs = await hostSocket(host);
    await accept(ref.signKey(), inviteId, proof);
    await hostWs.nextT("cloud.changed");
  });

  it("answers 409 to a second key, 403 to a wrong proof or an unknown invite, 400 to a malformed one, 401 unsigned", async () => {
    const { inviteId, proof } = await setup();
    const a = ref.signKey();
    expect((await accept(a, inviteId, secrets().proof)).status).toBe(403);
    // The stored hash isn't a proof: the client must send sha256hex(t), not what the cloud keeps.
    expect((await accept(a, inviteId, secrets().tokenHash)).status).toBe(403);
    expect((await accept(a, "binv_missing", proof)).status).toBe(403);
    expect((await accept(a, inviteId, "nothex")).status).toBe(400);
    expect((await call("POST", `/v1/bot-invites/${inviteId}/accept`, { body: { token: proof, name: "Rex" } })).status).toBe(401);
    expect((await call("POST", `/v1/bot-invites/${inviteId}/accept`, { key: a, body: { token: proof } })).status).toBe(400);
    expect((await accept(a, inviteId, proof)).status).toBe(200);
    const lost = await accept(ref.signKey(), inviteId, proof);
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe("inviteUsed");
  });

  it("is single use: the cloud keeps no token, only the hash of the proof", async () => {
    const { inviteId, proof, tokenHash } = await setup();
    const row = await env.DB.prepare("SELECT token_hash FROM bot_invites WHERE invite_id = ?").bind(inviteId).first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(tokenHash);
    expect(row?.token_hash).not.toBe(proof);
  });

  it("refuses a replayed signed request", async () => {
    const { inviteId, proof } = await setup();
    const bot = ref.signKey();
    const nonce = ref.b64url(ref.random(16));
    expect((await accept(bot, inviteId, proof, { nonce })).status).toBe(200);
    const replay = await accept(bot, inviteId, proof, { nonce });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("badSignature");
  });

  it("answers 410 to an expired invite, even to a key that never held it", async () => {
    const host = await newHost();
    const short = await invite(host);
    await env.DB.prepare("UPDATE bot_invites SET expires_at = ? WHERE invite_id = ?").bind(Date.now() - 1, short.inviteId).run();
    const r = await accept(ref.signKey(), short.inviteId, short.proof);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("inviteExpired");
    expect((await state(host)).botDevices).toEqual([]);
  });

  it("keeps a bot's device after the invite's own expiry, and its retry still works", async () => {
    const host = await newHost();
    const short = await invite(host);
    const bot = ref.signKey();
    const first = await accept(bot, short.inviteId, short.proof);
    expect(first.status).toBe(200);
    await env.DB.prepare("UPDATE bot_invites SET expires_at = ? WHERE invite_id = ?").bind(Date.now() - 1, short.inviteId).run();
    expect((await accept(bot, short.inviteId, short.proof)).body).toEqual(first.body);
  });

  it("lets exactly one of two keys win a race", async () => {
    const { host, inviteId, proof } = await setup();
    const results = await Promise.all([accept(ref.signKey(), inviteId, proof), accept(ref.signKey(), inviteId, proof)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await state(host)).botDevices).toHaveLength(1);
  });

  it("lets one key's two concurrent attempts share a device", async () => {
    const { host, inviteId, proof } = await setup();
    const bot = ref.signKey();
    const [a, b] = await Promise.all([accept(bot, inviteId, proof), accept(bot, inviteId, proof)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.botDeviceId).toBe(b.body.botDeviceId);
    expect((await state(host)).botDevices).toHaveLength(1);
  });

  it("won't give one key two bots on a computer, and leaves that invite open for another key", async () => {
    const { host, inviteId, proof } = await setup();
    const bot = ref.signKey();
    expect((await accept(bot, inviteId, proof)).status).toBe(200);
    const second = await invite(host);
    const dup = await accept(bot, second.inviteId, second.proof);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("conflict");
    expect((await accept(ref.signKey(), second.inviteId, second.proof)).status).toBe(200);
  });

  it("caps active bot devices at 50 per computer", async () => {
    const host = await newHost();
    // 49 bots straight into D1; the 50th and 51st go through the route.
    await env.DB.batch(
      Array.from({ length: 49 }, (_, i) => [
        env.DB.prepare("INSERT INTO bot_invites(invite_id, computer_id, token_hash, expires_at, created_at, accepted_at) VALUES (?, ?, 'x', 1, 1, 1)").bind(`fill_${i}`, host.cid),
        env.DB.prepare("INSERT INTO bot_devices(bot_device_id, computer_id, invite_id, sign_pub, name, created_at) VALUES (?, ?, ?, ?, 'f', 1)").bind(`bd_fill${i}`, host.cid, `fill_${i}`, `k${i}`),
      ]).flat(),
    );
    const last = await invite(host);
    expect((await accept(ref.signKey(), last.inviteId, last.proof)).status).toBe(200);
    const inv = await invite(host);
    const over = await accept(ref.signKey(), inv.inviteId, inv.proof);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("tooMany");
    // The failed accept didn't burn the invite: a revoke makes room for it.
    await call("POST", "/v1/host/bot-devices/bd_fill0/revoke", { key: host.sign, body: {} });
    expect((await accept(ref.signKey(), inv.inviteId, inv.proof)).status).toBe(200);
  }, 60_000);

  it("limits accepts per IP", async () => {
    const { inviteId, proof } = await setup();
    const ip = "192.0.2.77";
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await accept(ref.signKey(), inviteId, proof, { ip })).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("answers 410 when the computer is blocked", async () => {
    const { host, inviteId, proof } = await setup();
    await env.DB.prepare("UPDATE computers SET status = 'blocked' WHERE id = ?").bind(host.cid).run();
    const r = await accept(ref.signKey(), inviteId, proof);
    expect(r.status).toBe(410);
  });
});

describe("revoking a bot device", () => {
  it("drops it from state, blocks and closes its socket, and a used invite doesn't bring it back", async () => {
    const { host, inviteId, proof } = await setup();
    const bot = ref.signKey();
    const joined = await accept(bot, inviteId, proof);
    const hostWs = await hostSocket(host, [{ dk: dkOf(bot), grant: `bot:${joined.body.botDeviceId}`, kind: "bot" }]);
    const sock = await socket(devicePath(host), bot);
    await hostWs.nextT("open");
    const path = `/v1/host/bot-devices/${joined.body.botDeviceId}/revoke`;
    expect((await call("POST", path, { key: ref.signKey(), body: {} })).status).toBe(404);
    expect((await call("POST", path, { key: (await newHost()).sign, body: {} })).status).toBe(404);
    expect((await call("POST", path, { key: host.sign, body: {} })).body).toEqual({ ok: true });
    expect(await sock.closed()).toBe(4003);
    expect((await state(host)).botDevices).toEqual([]);
    // Still listed in a stale ACL, but blocked at the upgrade.
    expect((await upgrade(devicePath(host), bot)).status).toBe(403);
    expect((await call("POST", path, { key: host.sign, body: {} })).status).toBe(200);
    const r = await accept(bot, inviteId, proof);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("inviteRevoked");
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'botdevice.revoke' AND target = ?", joined.body.botDeviceId)).toBe(1);
  });

  it("lets the same key join again with a fresh invite, under a new grant", async () => {
    const { host, inviteId, proof } = await setup();
    const bot = ref.signKey();
    const joined = await accept(bot, inviteId, proof);
    await call("POST", `/v1/host/bot-devices/${joined.body.botDeviceId}/revoke`, { key: host.sign, body: {} });
    const fresh = await invite(host);
    const again = await accept(bot, fresh.inviteId, fresh.proof);
    expect(again.status).toBe(200);
    expect(again.body.botDeviceId).not.toBe(joined.body.botDeviceId);
    // The host lists it under the new grant id, which lifts the block.
    const hostWs = await hostSocket(host, [{ dk: dkOf(bot), grant: `bot:${again.body.botDeviceId}`, kind: "bot" }]);
    expect(hostWs).toBeTruthy();
    expect((await upgrade(devicePath(host), bot)).status).toBe(101);
  });

  it("leaves human grants and memberships alone", async () => {
    const { host, inviteId, proof } = await setup();
    const joined = await accept(ref.signKey(), inviteId, proof);
    const human = ref.signKey();
    const hostWs = await hostSocket(host, [{ dk: dkOf(human), grant: null }]);
    const dev = await socket(devicePath(host), human);
    await hostWs.nextT("open");
    await call("POST", `/v1/host/bot-devices/${joined.body.botDeviceId}/revoke`, { key: host.sign, body: {} });
    await dev.none((m) => m.t === "close", 200);
    expect(dev.close).toBeUndefined();
  });
});

describe("sweep", () => {
  it("deletes processed events and finished access requests older than 30 days, and keeps recent and pending ones", async () => {
    const day = 86_400_000;
    const now = Date.now();
    for (const [id, age] of [["old", 31], ["new", 29]] as const)
      await env.DB.prepare("INSERT INTO processed_events(provider, event_id, processed_at) VALUES ('clerk', ?, ?)").bind(`sw_${id}`, now - age * day).run();
    const host = await newHost();
    await env.DB.prepare("INSERT INTO accounts(user_id, created_at) VALUES ('sw_user', ?)").bind(now).run();
    await env.DB.prepare("INSERT INTO devices(id, owner_user_id, sign_pub, name, platform, created_at) VALUES ('sw_dev', 'sw_user', 'sw_pub', 'x', 'ios', ?)").bind(now).run();
    const req = (id: string, status: string, age: number) =>
      env.DB.prepare(
        `INSERT INTO access_requests(id, computer_id, device_id, user_id, status, commit_hash, created_at, expires_at)
         VALUES (?, ?, 'sw_dev', 'sw_user', ?, 'h', ?, ?)`,
      ).bind(id, host.cid, status, now - age * day, now - age * day + 600_000).run();
    await req("sw_old_approved", "approved", 40);
    await req("sw_old_denied", "denied", 40);
    await req("sw_old_cancelled", "cancelled", 40);
    await req("sw_new_approved", "approved", 5);
    await req("sw_old_pending", "pending", 40);
    await sweep(env, now);
    await sweep(env, now); // twice: nothing left to delete, nothing breaks
    const ev = await env.DB.prepare("SELECT event_id FROM processed_events WHERE event_id LIKE 'sw_%'").all<{ event_id: string }>();
    expect(ev.results.map((r) => r.event_id)).toEqual(["sw_new"]);
    const rq = await env.DB.prepare("SELECT id FROM access_requests WHERE id LIKE 'sw_%'").all<{ id: string }>();
    // The old pending one is flipped to expired by the same sweep and is deleted by the second sweep.
    expect(rq.results.map((r) => r.id).sort()).toEqual(["sw_new_approved"]);
  });

  it("deletes unaccepted bot invites expired more than 7 days ago, and keeps the rest", async () => {
    const host = await newHost();
    const stale = await invite(host);
    const recent = await invite(host);
    const taken = await invite(host);
    await accept(ref.signKey(), taken.inviteId, taken.proof);
    const day = 86_400_000;
    await env.DB.prepare("UPDATE bot_invites SET expires_at = ? WHERE invite_id = ?").bind(Date.now() - 8 * day, stale.inviteId).run();
    await env.DB.prepare("UPDATE bot_invites SET expires_at = ? WHERE invite_id = ?").bind(Date.now() - 6 * day, recent.inviteId).run();
    await env.DB.prepare("UPDATE bot_invites SET expires_at = ? WHERE invite_id = ?").bind(Date.now() - 8 * day, taken.inviteId).run();
    await sweep(env, Date.now());
    const left = await env.DB.prepare("SELECT invite_id FROM bot_invites WHERE computer_id = ?").bind(host.cid).all<{ invite_id: string }>();
    expect(left.results.map((r) => r.invite_id).sort()).toEqual([recent.inviteId, taken.inviteId].sort());
  });
});

// ---- relay: ACL kind, caps, rate, mailbox ----

describe("ACL kind", () => {
  const dk = dkOf(ref.signKey());
  const acl = (devices: unknown) => ref.enc.encode(JSON.stringify({ v: 1, computerId: "c", ver: 1, devices, offers: [] }));

  it("parses kind bot, and entries without a kind exactly as before", () => {
    const parsed = parseAcl(acl([{ dk, grant: null }, { dk, grant: "bot:bd_x", kind: "bot" }]));
    expect(parsed?.devices).toEqual([{ dk, grant: null }, { dk, grant: "bot:bd_x", kind: "bot" }]);
  });

  it("rejects any other kind", () => {
    expect(parseAcl(acl([{ dk, grant: null, kind: "admin" }]))).toBeNull();
    expect(parseAcl(acl([{ dk, grant: null, kind: null }]))).toBeNull();
    expect(parseAcl(acl([{ dk, grant: null, kind: "" }]))).toBeNull();
  });
});

/** A host with bots (kind: "bot") and humans in its ACL. */
async function botRelay(o: { bots?: number; humans?: number; ready?: boolean } = {}) {
  const host = await newHost();
  const bots = Array.from({ length: o.bots ?? 1 }, () => ref.signKey());
  const humans = Array.from({ length: o.humans ?? 0 }, () => ref.signKey());
  const hostWs = await hostSocket(
    host,
    [
      ...humans.map((k) => ({ dk: dkOf(k), grant: null })),
      ...bots.map((k, i) => ({ dk: dkOf(k), grant: `bot:bd_${i}`, kind: "bot" as const })),
    ],
    { ready: o.ready },
  );
  return { host, bots, humans, hostWs };
}

describe("bot sockets", () => {
  it("caps bots at 8 sockets per computer and 2 per key, without touching an open phone", async () => {
    const { host, bots, humans } = await botRelay({ bots: 5, humans: 1 });
    const phone = await socket(devicePath(host), humans[0]!);
    expect((await upgrade(devicePath(host), bots[0]!)).status).toBe(101);
    expect((await upgrade(devicePath(host), bots[0]!)).status).toBe(101);
    expect((await upgrade(devicePath(host), bots[0]!)).status).toBe(429);
    for (const k of bots.slice(1, 4)) {
      expect((await upgrade(devicePath(host), k)).status).toBe(101);
      expect((await upgrade(devicePath(host), k)).status).toBe(101);
    }
    // Eight bot sockets are open: a fifth key is over the computer cap.
    expect((await upgrade(devicePath(host), bots[4]!)).status).toBe(429);
    expect(phone.close).toBeUndefined();
  });

  it("keeps bots from filling the human pool, and humans from filling the bot pool", async () => {
    const { host, bots, humans } = await botRelay({ bots: 4, humans: 17 });
    for (const k of humans.slice(0, 16)) expect((await upgrade(devicePath(host), k)).status).toBe(101);
    expect((await upgrade(devicePath(host), humans[16]!)).status).toBe(429);
    // 16 human sockets are open and a bot still gets in, up to its own 8.
    for (const k of bots) {
      expect((await upgrade(devicePath(host), k)).status).toBe(101);
      expect((await upgrade(devicePath(host), k)).status).toBe(101);
    }
    expect((await upgrade(devicePath(host), bots[0]!)).status).toBe(429);
  });

  it("limits a bot's link to 60 messages per 10 s while a human keeps 200", async () => {
    const { host, bots, humans, hostWs } = await botRelay({ bots: 1, humans: 1 });
    const bot = await socket(devicePath(host), bots[0]!);
    const human = await socket(devicePath(host), humans[0]!);
    await hostWs.nextT("open");
    await hostWs.nextT("open");
    // A literal {"t":"ping"} is answered by the socket auto-response and never reaches the DO, so send frames.
    for (let i = 0; i < 60; i++) bot.send({ t: "f", i });
    for (let i = 0; i < 100; i++) human.send({ t: "f", i });
    await bot.none((m) => m.t === "never", 100);
    expect(bot.close).toBeUndefined();
    bot.send({ t: "f", i: 61 });
    expect(await bot.closed()).toBe(4008);
    expect(human.close).toBeUndefined();
  });

  it("limits a bot's link to 1 MiB per 10 s", async () => {
    const { host, bots } = await botRelay({ bots: 1 });
    const bot = await socket(devicePath(host), bots[0]!);
    const chunk = "x".repeat(200 * 1024);
    for (let i = 0; i < 6; i++) bot.send({ t: "f", d: chunk });
    expect(await bot.closed()).toBe(4008);
  });

  it("answers a bot's mailbox messages with notAllowed, online or not", async () => {
    const { host, bots, hostWs } = await botRelay({ bots: 1, ready: false });
    const bot = await socket(devicePath(host), bots[0]!);
    await bot.nextT("presence");
    const put = (nonce: string) => bot.send({ t: "mbox.put", nonce, d: ref.b64url(ref.random(200)) });
    put("n1");
    expect(await bot.nextT("mbox.err")).toEqual({ t: "mbox.err", nonce: "n1", code: "notAllowed" });
    bot.send({ t: "mbox.list" });
    expect((await bot.nextT("mbox.err")).code).toBe("notAllowed");
    bot.send({ t: "mbox.cancel", nonce: "n1" });
    expect((await bot.nextT("mbox.err")).code).toBe("notAllowed");
    // Nothing was queued: a host that comes online gets no mailbox item.
    hostWs.send({ t: "ready" });
    await hostWs.none((m) => m.t === "mbox.item", 200);
    expect(bot.close).toBeUndefined();
  });

  it("still queues a human's mailbox message on the same computer", async () => {
    const { host, humans } = await botRelay({ bots: 1, humans: 1, ready: false });
    const human = await socket(devicePath(host), humans[0]!);
    await human.nextT("presence");
    human.send({ t: "mbox.put", nonce: "h1", d: ref.b64url(ref.random(200)) });
    expect((await human.nextT("mbox.ok")).state).toBe("queued");
  });

  it("forwards a bot's frames to the host like any device", async () => {
    const { host, bots, hostWs } = await botRelay({ bots: 1 });
    const bot = await socket(devicePath(host), bots[0]!);
    const open = await hostWs.nextT("open");
    expect(open.dk).toBe(dkOf(bots[0]!));
    bot.send({ t: "hello", x: 1 });
    const data = await hostWs.nextT("data");
    expect(data.link).toBe(open.link);
    expect(data.m).toEqual({ t: "hello", x: 1 });
  });

  it("never lets a bot key use a pairing offer", async () => {
    const host = await newHost();
    const bot = ref.signKey();
    const offer = ref.offerId(ref.random(16));
    await hostSocket(host, [{ dk: dkOf(bot), grant: "bot:bd_1", kind: "bot" }], { offers: [{ id: offer, exp: Date.now() + 600_000 }] });
    expect((await upgrade(devicePath(host, offer), bot)).status).toBe(403);
    // The offer itself still works for a new key.
    expect((await upgrade(devicePath(host, offer), ref.signKey())).status).toBe(101);
  });

  it("closes a connected socket whose kind changes in a new ACL", async () => {
    const { host, bots, humans, hostWs } = await botRelay({ bots: 1, humans: 1 });
    const bot = await socket(devicePath(host), bots[0]!);
    const human = await socket(devicePath(host), humans[0]!);
    await hostWs.nextT("open");
    await hostWs.nextT("open");
    // Both stay listed, the bot as a human and the human as a bot: neither socket fits the limits it was admitted under.
    hostWs.send(
      ref.aclMessage(host.sign, {
        v: 1,
        computerId: host.cid,
        ver: 10,
        devices: [{ dk: dkOf(bots[0]!), grant: null }, { dk: dkOf(humans[0]!), grant: "bot:bd_9", kind: "bot" }],
        offers: [],
      }),
    );
    await hostWs.nextT("acl.ok");
    expect(await bot.closed()).toBe(4003);
    expect(await human.closed()).toBe(4003);
  });

  it("closes a bot's socket when a new ACL no longer lists it", async () => {
    const { host, bots, hostWs } = await botRelay({ bots: 1 });
    const bot = await socket(devicePath(host), bots[0]!);
    await hostWs.nextT("open");
    hostWs.send(ref.aclMessage(host.sign, { v: 1, computerId: host.cid, ver: 10, devices: [], offers: [] }));
    await hostWs.nextT("acl.ok");
    expect(await bot.closed()).toBe(4003);
  });

  it("admits a bot dk only when the ACL lists it", async () => {
    const { host } = await botRelay({ bots: 1 });
    expect((await upgrade(devicePath(host), ref.signKey())).status).toBe(403);
  });
});
