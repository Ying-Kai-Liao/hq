// Alert aps: `mutableContent` passes through as `mutable-content: 1`, and only when asked.
import assert from "node:assert/strict";
import worker, { alertAps, liveActivityAps, tokenIsGone, sealTicket } from "../src/index.ts";

const base = { alert: { title: "Codync", body: "Needs you" }, threadId: "b1", category: "needsInput" };
assert.equal(alertAps({ ...base, mutableContent: true })["mutable-content"], 1);
assert.equal("mutable-content" in alertAps(base), false);
assert.equal("mutable-content" in alertAps({ ...base, mutableContent: false }), false);
assert.deepEqual(alertAps(base).alert, { title: "Codync", body: "Needs you" });
console.log("push tests ok");

const state = { status: "working", activity: "", startedAt: 1 };
const update = liveActivityAps({ event: "update", timestamp: 100, contentState: state }, 100);
assert.equal(update.timestamp, 100);
assert.equal(update["stale-date"], 1000);
assert.equal("dismissal-date" in update, false);
const ended = liveActivityAps({ event: "end", timestamp: 100, contentState: { ...state, status: "error" } }, 150);
assert.equal(ended["dismissal-date"], 160);
assert.equal((ended["content-state"] as typeof state).status, "error");
assert.equal("stale-date" in ended, false);
assert.throws(() => liveActivityAps({ event: "update", contentState: { ...state, activity: "private task text" } }));
assert.throws(() => liveActivityAps({ event: "update", timestamp: 200, contentState: state }, 100));
assert.throws(() => liveActivityAps({ event: "update", contentState: { ...state, status: "unknown" } }));
assert.throws(() => liveActivityAps({ event: "update", contentState: { ...state, status: ["working"] } }));
assert.equal(tokenIsGone({ reason: "ExpiredProviderToken", statusCode: 403 }), false);
assert.equal(tokenIsGone({ reason: "Unregistered", statusCode: 410 }), true);
assert.equal(tokenIsGone({ reason: "BadDeviceToken", statusCode: 400 }), true);
console.log("Live Activity payload tests ok");

const env = { TICKET_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) } as any;
const ticket = await sealTicket(env, { t: "ab".repeat(32), e: "sandbox", k: "alert" });
async function request(path: string, body: unknown) {
  return worker.fetch(new Request(`https://relay.test${path}`, { method: "POST", body: JSON.stringify(body) }), env);
}
assert.equal((await request("/register", { token: "ab".repeat(32), env: "typo", kind: "alert" })).status, 400);
assert.equal((await request("/push", { ticket, alert: { title: 123 } })).status, 400);
assert.equal((await request("/push", { ticket, alert: { body: "fallback" }, data: { aps: {} } })).status, 400);
assert.equal((await request("/push", { ticket, alert: { body: "fallback" }, data: { sealed: "x".repeat(4096) } })).status, 413);
const activityTicket = await sealTicket(env, { t: "ab".repeat(32), e: "sandbox", k: "liveactivity" });
assert.equal((await request("/push", { ticket: activityTicket, liveActivity: { event: "start", contentState: state } })).status, 400);
console.log("push request validation tests ok");
