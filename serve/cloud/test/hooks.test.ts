// Public routine webhooks (§7.8): ingress checks, the per-computer queue, delivery to the host and acks.

import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ComputerRelay } from "../src/relay";
import { env, hostSocket, newHost, ORIGIN, type TestHost } from "./helpers";

const KEY = "k".repeat(64);
const stub = (host: TestHost) => env.RELAY.get(env.RELAY.idFromName(host.cid)) as DurableObjectStub<ComputerRelay>;

async function post(host: TestHost, hook: string, o: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await SELF.fetch(`${ORIGIN}/v1/hooks/${host.cid}/${hook}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.1.${Math.floor(Math.random() * 255)}.1`, ...o.headers },
    body: o.body ?? '{"text":"hi"}',
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
}

const bearer = (key = KEY) => ({ Authorization: `Bearer ${key}` });

async function hmac(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A ready host that registered `hooks`. */
async function withHooks(hooks: { id: string; key?: string; enabled?: boolean }[], o: { ready?: boolean } = {}) {
  const host = await newHost();
  const ws = await hostSocket(host, [], o);
  ws.send({ t: "hooks", hooks: hooks.map((h) => ({ id: h.id, key: h.key ?? KEY, enabled: h.enabled ?? true })) });
  expect(await ws.nextT("hooks.ok")).toEqual({ t: "hooks.ok", n: hooks.length });
  return { host, ws };
}

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

describe("ingress", () => {
  it("refuses unknown computers, unknown hooks and wrong keys alike", async () => {
    const { host } = await withHooks([{ id: "r1" }]);
    expect((await post({ ...host, cid: "A".repeat(22) }, "r1", { headers: bearer() })).status).toBe(404);
    expect((await post(host, "bad id!", { headers: bearer() })).status).toBe(404);
    const unknown = await post(host, "r2", { headers: bearer() });
    const wrong = await post(host, "r1", { headers: bearer("x".repeat(64)) });
    const missing = await post(host, "r1");
    for (const r of [unknown, wrong, missing]) {
      expect(r.status).toBe(401);
      expect(r.body.error?.code).toBe("unauthorized");
    }
  });

  it("accepts a bearer key or a GitHub signature of the exact body", async () => {
    const { host } = await withHooks([{ id: "r1" }]);
    expect((await post(host, "r1", { headers: bearer() })).status).toBe(202);
    const body = '{"action":"opened"}';
    expect((await post(host, "r1", { body, headers: { "X-Hub-Signature-256": await hmac(KEY, body) } })).status).toBe(202);
    expect((await post(host, "r1", { body: `${body} `, headers: { "X-Hub-Signature-256": await hmac(KEY, body) } })).status).toBe(401);
    expect((await post(host, "r1", { body, headers: { "X-Hub-Signature-256": await hmac("y".repeat(64), body) } })).status).toBe(401);
    expect((await post(host, "r1", { body, headers: { "X-Hub-Signature-256": "sha256=zz" } })).status).toBe(401);
  });

  it("refuses paused hooks, oversized bodies and unusable delivery ids", async () => {
    const { host } = await withHooks([{ id: "off", enabled: false }, { id: "on" }]);
    const paused = await post(host, "off", { headers: bearer() });
    expect(paused.status).toBe(409);
    expect(paused.body.error?.code).toBe("paused");
    expect((await post(host, "on", { headers: bearer(), body: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    expect((await post(host, "on", { headers: { ...bearer(), "X-Delivery-Id": "has space" } })).status).toBe(400);
  });

  it("queues each delivery id once", async () => {
    const { host } = await withHooks([{ id: "r1" }], { ready: false });
    const first = await post(host, "r1", { headers: { ...bearer(), "X-GitHub-Delivery": "d-1" } });
    expect(first).toEqual({ status: 202, body: { delivery: "d-1", queued: true } });
    const again = await post(host, "r1", { headers: { ...bearer(), "X-GitHub-Delivery": "d-1" } });
    expect(again.body).toEqual({ delivery: "d-1", queued: true, duplicate: true });
  });

  it("caps a hook's queue at 100", async () => {
    const { host } = await withHooks([{ id: "r1" }], { ready: false });
    for (let i = 0; i < 100; i++) expect((await post(host, "r1", { headers: bearer() })).status).toBe(202);
    const full = await post(host, "r1", { headers: bearer() });
    expect(full.status).toBe(429);
    expect(full.body.error?.code).toBe("full");
  });
});

describe("delivery", () => {
  it("hands the host one delivery at a time with its body and forwarded headers", async () => {
    const { host, ws } = await withHooks([{ id: "r1" }]);
    await post(host, "r1", { body: '{"n":1}', headers: { ...bearer(), "X-Delivery-Id": "a", "X-GitHub-Event": "push", Cookie: "secret" } });
    await post(host, "r1", { body: '{"n":2}', headers: { ...bearer(), "X-Delivery-Id": "b" } });
    const item = await ws.nextT("hook.item");
    expect(item).toMatchObject({ t: "hook.item", hook: "r1", delivery: "a" });
    expect(decode(item.body)).toBe('{"n":1}');
    expect(item.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "x-github-event": "push", "x-delivery-id": "a" });
    expect(item.headers.cookie).toBeUndefined();
    await ws.none((m) => m.t === "hook.item");
    ws.send({ t: "hook.ack", seq: item.seq, ok: true });
    const next = await ws.nextT("hook.item");
    expect(next.delivery).toBe("b");
    ws.send({ t: "hook.ack", seq: next.seq, ok: true });
    await ws.none((m) => m.t === "hook.item");
  });

  it("keeps deliveries while the host is away and sends them once it is ready", async () => {
    const { host, ws } = await withHooks([{ id: "r1" }], { ready: false });
    await post(host, "r1", { headers: { ...bearer(), "X-Delivery-Id": "while-away" } });
    await ws.none((m) => m.t === "hook.item");
    ws.send({ t: "ready" });
    expect((await ws.nextT("hook.item")).delivery).toBe("while-away");
  });

  it("puts an unacknowledged delivery back when the host drops", async () => {
    const { host, ws } = await withHooks([{ id: "r1" }]);
    await post(host, "r1", { headers: { ...bearer(), "X-Delivery-Id": "x" } });
    await ws.nextT("hook.item");
    ws.ws.close(1000);
    const again = await hostSocket(host);
    expect((await again.nextT("hook.item")).delivery).toBe("x");
  });

  it("retries a busy delivery later without holding up the others", async () => {
    const { host, ws } = await withHooks([{ id: "r1" }, { id: "r2" }]);
    await post(host, "r1", { headers: { ...bearer(), "X-Delivery-Id": "busy" } });
    await post(host, "r2", { headers: { ...bearer(), "X-Delivery-Id": "other" } });
    const busy = await ws.nextT("hook.item");
    ws.send({ t: "hook.ack", seq: busy.seq, ok: false, retry: true });
    const other = await ws.nextT("hook.item");
    expect(other.delivery).toBe("other");
    ws.send({ t: "hook.ack", seq: other.seq, ok: true });
    await ws.none((m) => m.t === "hook.item");
    // Due again: the alarm hands it back.
    await stubSql(host, "UPDATE hookbox SET not_before = 0");
    await runDurableObjectAlarm(stub(host));
    expect((await ws.nextT("hook.item")).delivery).toBe("busy");
  });

  it("drops a refused delivery and queued ones of removed hooks", async () => {
    const { host, ws } = await withHooks([{ id: "r1" }, { id: "r2" }]);
    await post(host, "r1", { headers: { ...bearer(), "X-Delivery-Id": "one" } });
    await post(host, "r2", { headers: { ...bearer(), "X-Delivery-Id": "gone" } });
    const one = await ws.nextT("hook.item");
    ws.send({ t: "hooks", hooks: [{ id: "r1", key: KEY, enabled: true }] });
    await ws.nextT("hooks.ok");
    ws.send({ t: "hook.ack", seq: one.seq, ok: false, code: "unauthorized" });
    await ws.none((m) => m.t === "hook.item");
    expect((await post(host, "r2", { headers: bearer() })).status).toBe(401);
  });

  it("rejects a malformed hooks list and keeps the stored one", async () => {
    const { host, ws } = await withHooks([{ id: "r1" }]);
    for (const hooks of [[{ id: "r1", key: "short", enabled: true }], [{ id: "r1", key: KEY }], "nope", [{ id: "r1", key: KEY, enabled: true }, { id: "r1", key: KEY, enabled: true }]]) {
      ws.send({ t: "hooks", hooks });
      expect(await ws.nextT("error")).toEqual({ t: "error", code: "badHooks" });
    }
    expect((await post(host, "r1", { headers: bearer() })).status).toBe(202);
  });

  it("expires queued deliveries after 72 hours", async () => {
    const { host } = await withHooks([{ id: "r1" }], { ready: false });
    await post(host, "r1", { headers: bearer() });
    await stubSql(host, "UPDATE hookbox SET exp = 1");
    await runDurableObjectAlarm(stub(host));
    expect(await stubSql(host, "SELECT COUNT(*) AS n FROM hookbox")).toEqual([{ n: 0 }]);
  });
});

function stubSql(host: TestHost, query: string): Promise<unknown[]> {
  return runInDurableObject(stub(host), (_obj, state) => state.storage.sql.exec(query).toArray());
}
