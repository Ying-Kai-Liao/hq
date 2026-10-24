// Web devices: platform "web" bound to a live Clerk session, subprotocol socket auth, max-age, signed retire, CORS.

import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { ComputerRelay } from "../src/relay";
import { call, clerkToken, devicePath, env, hostSocket, newHost, Sock, type TestHost } from "./helpers";
import * as ref from "./ref";

const WEB = "https://web.test";
const stub = (host: TestHost) => env.RELAY.get(env.RELAY.idFromName(host.cid)) as DurableObjectStub<ComputerRelay>;
const dkOf = (k: ref.SignKey) => ref.b64url(k.pub);
const user = () => "user_web_" + ref.b64url(ref.random(8));

// ---- a mocked Clerk Backend API: GET /v1/sessions/:id ----

const sessions = new Map<string, string>();
let clerkDown = false;
const realFetch = globalThis.fetch;
function mockClerk() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.host !== "api.clerk.com") return realFetch(input, init);
    if (clerkDown) throw new Error("clerk unreachable");
    const sid = url.pathname.split("/").pop()!;
    const status = sessions.get(sid);
    return status ? Response.json({ id: sid, status }) : Response.json({ errors: [] }, { status: 404 });
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  sessions.clear();
  clerkDown = false;
});

/** A session token as the browser would hold it, and the session Clerk reports live for it. */
async function login(sub: string, sid = "sess_" + Array.from(ref.random(6), (b) => b.toString(16).padStart(2, "0")).join(""), status = "active") {
  sessions.set(sid, status);
  return { sub, sid, jwt: await clerkToken(sub, { sid, azp: WEB }) };
}

const registerWeb = (jwt: string, key: ref.SignKey, platform = "web") =>
  call("POST", "/v1/devices", { token: jwt, key, body: { name: "Brother's browser", platform } });

async function devicesRow(key: ref.SignKey) {
  return env.DB.prepare("SELECT * FROM devices WHERE sign_pub = ?").bind(dkOf(key)).first<{
    id: string;
    platform: string;
    clerk_sid: string | null;
    revoked_at: number | null;
  }>();
}

/** The browser form of the upgrade. */
async function webUpgrade(
  host: TestHost,
  key: ref.SignKey,
  o: { jwt?: string | null; origin?: string | null; nonce?: string; path?: string; sigValue?: string } = {},
): Promise<{ res: Response; sock: Sock }> {
  const path = o.path ?? devicePath(host);
  const sig = o.sigValue ?? ref.signRequest(key, { method: "GET", authority: "cloud.test", pathAndQuery: path, nonce: o.nonce });
  const protocols = ["kith.v1", `kith-sig.${ref.b64url(ref.enc.encode(sig))}`];
  if (o.jwt !== null && o.jwt !== undefined) protocols.push(`kith-jwt.${o.jwt}`);
  const headers: Record<string, string> = { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols.join(", ") };
  if (o.origin !== null) headers.Origin = o.origin ?? WEB;
  const res = await SELF.fetch("https://cloud.test" + path, { headers });
  expect(res.status).toBe(101);
  return { res, sock: new Sock(res.webSocket!) };
}

/** A host with the web key listed in its ACL (granted: a D1 grant row too, so revokes can block it). */
let grantId = "";
async function setup(opts: { granted?: boolean } = {}) {
  grantId = "grt_" + ref.b64url(ref.random(6));
  mockClerk();
  const host = await newHost();
  const key = ref.signKey();
  const hostWs = await hostSocket(host, [{ dk: dkOf(key), grant: opts.granted ? grantId : null }]);
  return { host, key, hostWs };
}

async function registered(sub = user()) {
  const s = await setup({ granted: true });
  const l = await login(sub);
  const r = await registerWeb(l.jwt, s.key);
  expect(r.status).toBe(200);
  const row = (await devicesRow(s.key))!;
  await env.DB.prepare("INSERT INTO grants(id,computer_id,device_id,scopes,status,created_at) VALUES (?,?,?,'[]','active',1)")
    .bind(grantId, s.host.cid, row.id)
    .run();
  return { ...s, ...l, deviceId: row.id };
}

describe("registering a web device", () => {
  it("binds the row to the session and re-binds on a new sign-in", async () => {
    mockClerk();
    const key = ref.signKey();
    const a = await login(user());
    const first = await registerWeb(a.jwt, key);
    expect(first.status).toBe(200);
    expect(first.body.device.platform).toBe("web");
    expect((await devicesRow(key))!.clerk_sid).toBe(a.sid);
    // Same user, a newer session: last write wins.
    const b = await login(a.sub);
    expect((await registerWeb(b.jwt, key)).status).toBe(200);
    expect((await devicesRow(key))!.clerk_sid).toBe(b.sid);
  });

  it("refuses when Clerk says the session is not active, errors, or the token is for another origin", async () => {
    mockClerk();
    const ended = await login(user(), undefined, "ended");
    expect((await registerWeb(ended.jwt, ref.signKey())).status).toBe(401);
    const unknown = await clerkToken(user(), { sid: "sess_nobody", azp: WEB });
    expect((await registerWeb(unknown, ref.signKey())).status).toBe(401);
    clerkDown = true;
    const live = await login(user());
    expect((await registerWeb(live.jwt, ref.signKey())).status).toBe(401);
    clerkDown = false;
    const other = await clerkToken(user(), { sid: live.sid, azp: "https://evil.test" });
    expect((await registerWeb(other, ref.signKey())).status).toBe(401);
    const noAzp = await clerkToken(user(), { sid: live.sid, azp: undefined });
    expect((await registerWeb(noAzp, ref.signKey())).status).toBe(401);
  });

  it("keeps a revoked key refused", async () => {
    mockClerk();
    const key = ref.signKey();
    const l = await login(user());
    const r = await registerWeb(l.jwt, key);
    expect((await call("DELETE", "/v1/devices/" + r.body.device.deviceId, { token: l.jwt })).status).toBe(200);
    expect((await registerWeb(l.jwt, key)).status).toBe(403);
  });

  it("cannot turn a web key native or the reverse", async () => {
    mockClerk();
    const l = await login(user());
    const web = ref.signKey();
    await registerWeb(l.jwt, web);
    expect((await registerWeb(l.jwt, web, "ios")).status).toBe(409);
    const native = ref.signKey();
    expect((await registerWeb(l.jwt, native, "ios")).status).toBe(200);
    expect((await registerWeb(l.jwt, native, "web")).status).toBe(409);
  });

  it("leaves native devices alone: no Clerk call, no session bound", async () => {
    mockClerk();
    clerkDown = true;
    const key = ref.signKey();
    const token = await clerkToken(user());
    expect((await registerWeb(token, key, "ios")).status).toBe(200);
    expect((await devicesRow(key))!.clerk_sid).toBeNull();
  });
});

describe("web relay upgrade", () => {
  it("admits a live session over subprotocols and echoes kith.v1", async () => {
    const t = await registered();
    const { res, sock } = await webUpgrade(t.host, t.key, { jwt: t.jwt });
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("kith.v1");
    expect((await sock.nextT("presence")).online).toBe(true);
    await t.hostWs.nextT("open");
  });

  it("refuses with a close code, never an HTTP status", async () => {
    const t = await registered();
    const closes = async (p: ReturnType<typeof webUpgrade>) => (await p).sock.closed();

    // 4404: unknown computer
    const stranger = ref.computerId(ref.signKey().pub);
    expect(await closes(webUpgrade(t.host, t.key, { jwt: t.jwt, path: `/v1/relay/device/${stranger}?v=1` }))).toBe(4404);
    // 4426: needs update
    expect(await closes(webUpgrade(t.host, t.key, { jwt: t.jwt, path: devicePath(t.host).replace("v=1", "v=2") }))).toBe(4426);
    // 4401: no JWT for a web key, a bad signature, a JWT that doesn't verify
    expect(await closes(webUpgrade(t.host, t.key, { jwt: null }))).toBe(4401);
    expect(await closes(webUpgrade(t.host, t.key, { jwt: t.jwt, sigValue: "v=1,kid=x" }))).toBe(4401);
    expect(await closes(webUpgrade(t.host, t.key, { jwt: t.jwt + "x" }))).toBe(4401);
    // 4403: origin outside WEB_ORIGINS, or none at all
    expect(await closes(webUpgrade(t.host, t.key, { jwt: t.jwt, origin: "https://evil.test" }))).toBe(4403);
    expect(await closes(webUpgrade(t.host, t.key, { jwt: t.jwt, origin: null }))).toBe(4403);
    // 4403: a JWT for a key that is not a web device at all
    const native = ref.signKey();
    expect(await closes(webUpgrade(t.host, native, { jwt: t.jwt }))).toBe(4403);
  });

  it("refuses a sub that does not own the key (4403)", async () => {
    const t = await registered();
    const other = await login(user());
    const { sock } = await webUpgrade(t.host, t.key, { jwt: other.jwt });
    expect(await sock.closed()).toBe(4403);
  });

  it("refuses a sid that is not the bound one, or a cleared binding (4401)", async () => {
    const t = await registered();
    const newer = await login(t.sub);
    expect(await (await webUpgrade(t.host, t.key, { jwt: newer.jwt })).sock.closed()).toBe(4401);
    await env.DB.prepare("UPDATE devices SET clerk_sid = NULL WHERE id = ?").bind(t.deviceId).run();
    expect(await (await webUpgrade(t.host, t.key, { jwt: t.jwt })).sock.closed()).toBe(4401);
  });

  it("refuses a session Clerk no longer calls active, and fails closed when Clerk errors (4401)", async () => {
    const t = await registered();
    sessions.set(t.sid, "ended");
    expect(await (await webUpgrade(t.host, t.key, { jwt: t.jwt })).sock.closed()).toBe(4401);
    sessions.set(t.sid, "active");
    clerkDown = true;
    expect(await (await webUpgrade(t.host, t.key, { jwt: t.jwt })).sock.closed()).toBe(4401);
    clerkDown = false;
    const ok = await webUpgrade(t.host, t.key, { jwt: t.jwt });
    await ok.sock.nextT("presence");
  });

  it("refuses a revoked row and a replayed nonce", async () => {
    const t = await registered();
    const nonce = ref.b64url(ref.random(16));
    const first = await webUpgrade(t.host, t.key, { jwt: t.jwt, nonce });
    await first.sock.nextT("presence");
    expect(await (await webUpgrade(t.host, t.key, { jwt: t.jwt, nonce })).sock.closed()).toBe(4401);
    await env.DB.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").bind(t.deviceId).run();
    expect(await (await webUpgrade(t.host, t.key, { jwt: t.jwt })).sock.closed()).toBe(4403);
  });

  it("does not let a web key connect like a native device, header and all", async () => {
    const t = await registered();
    const res = await SELF.fetch("https://cloud.test" + devicePath(t.host), {
      headers: { Upgrade: "websocket", "Kith-Sig": ref.signRequest(t.key, { method: "GET", authority: "cloud.test", pathAndQuery: devicePath(t.host) }) },
    });
    expect(res.status).toBe(401);
  });

  it("closes a web socket after the max age with 4100, and leaves native sockets alone", async () => {
    const t = await registered();
    const web = await webUpgrade(t.host, t.key, { jwt: t.jwt });
    await web.sock.nextT("presence");
    const stored = await runInDurableObject(stub(t.host), (_, state) =>
      state.getWebSockets("device").map((ws) => (ws.deserializeAttachment() as { webUntil?: number }).webUntil),
    );
    // Default WEB_SOCKET_MAX_AGE: an hour.
    expect(stored[0]! - Date.now()).toBeGreaterThan(3_590_000);
    expect(stored[0]! - Date.now()).toBeLessThanOrEqual(3_600_000);
    await runInDurableObject(stub(t.host), (_, state) => {
      for (const ws of state.getWebSockets("device")) ws.serializeAttachment({ ...ws.deserializeAttachment(), webUntil: Date.now() - 1 });
    });
    await runDurableObjectAlarm(stub(t.host));
    expect(await web.sock.closed()).toBe(4100);
  });
});

describe("POST /v1/devices/retire", () => {
  it("revokes the row, closes its sockets and keeps the key refused", async () => {
    const t = await registered();
    const web = await webUpgrade(t.host, t.key, { jwt: t.jwt });
    await web.sock.nextT("presence");
    const r = await call("POST", "/v1/devices/retire", { key: t.key });
    expect(r.status).toBe(200);
    expect(await web.sock.closed()).toBe(4003);
    expect((await devicesRow(t.key))!.revoked_at).not.toBeNull();
    // A register signed before sign-out lands after it: refused.
    expect((await registerWeb(t.jwt, t.key)).status).toBe(403);
    expect(await (await webUpgrade(t.host, t.key, { jwt: t.jwt })).sock.closed()).toBe(4403);
    // Idempotent.
    expect((await call("POST", "/v1/devices/retire", { key: t.key })).status).toBe(200);
  });

  it("tombstones a key the cloud never saw", async () => {
    mockClerk();
    const key = ref.signKey();
    expect((await call("POST", "/v1/devices/retire", { key })).status).toBe(200);
    const l = await login(user());
    expect((await registerWeb(l.jwt, key)).status).toBe(403);
    expect(await devicesRow(key)).toBeNull();
  });

  it("needs the key's own signature", async () => {
    expect((await call("POST", "/v1/devices/retire", {})).status).toBe(401);
  });

  it("is what cuts a web device when the owner revokes it", async () => {
    const t = await registered();
    const web = await webUpgrade(t.host, t.key, { jwt: t.jwt });
    await web.sock.nextT("presence");
    expect((await call("DELETE", "/v1/devices/" + t.deviceId, { token: t.jwt })).status).toBe(200);
    expect(await web.sock.closed()).toBe(4003);
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    SELF.fetch("https://cloud.test/v1/devices", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, kith-sig" },
    });

  it("answers a preflight for a listed origin only", async () => {
    const ok = await preflight(WEB);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(ok.headers.get("Access-Control-Allow-Headers")).toMatch(/Kith-Sig/i);
    expect(ok.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/i);
    const no = await preflight("https://evil.test");
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(no.status).not.toBe(204);
  });

  it("adds the origin to real responses, never a wildcard", async () => {
    const ok = await SELF.fetch("https://cloud.test/v1/health", { headers: { Origin: WEB } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(ok.headers.get("Vary")).toMatch(/Origin/);
    const err = await SELF.fetch("https://cloud.test/v1/me", { headers: { Origin: WEB } });
    expect(err.status).toBe(401);
    expect(err.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    const no = await SELF.fetch("https://cloud.test/v1/health", { headers: { Origin: "https://evil.test" } });
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await SELF.fetch("https://cloud.test/v1/health")).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("is off when WEB_ORIGINS is unset", async () => {
    const bare = { ...env, WEB_ORIGINS: undefined };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://cloud.test/v1/health", { method: "OPTIONS", headers: { Origin: WEB, "Access-Control-Request-Method": "GET" } }),
      bare,
      ctx,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const get = await worker.fetch(new Request("https://cloud.test/v1/health", { headers: { Origin: WEB } }), bare, ctx);
    expect(get.status).toBe(200);
    expect(get.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

