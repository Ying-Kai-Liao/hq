// Public routine webhooks (spec §7.8): the checks a delivery passes before it is queued for the host.
//
// The host registers each webhook routine's id and key over its relay socket. A sender proves it holds
// the key with `Authorization: Bearer <key>` or, for GitHub and compatible senders, an
// `X-Hub-Signature-256` HMAC of the body. The host checks the same proof again before running anything.

import { utf8 } from "./auth";

export const HOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const HOOK_MAX_BODY = 64 * 1024;
const KEY_MIN = 32;
const KEY_MAX = 256;
const DELIVERY_MAX = 200;

/** Headers the host gets with a delivery; everything else stays at the edge. */
export const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "user-agent",
  "x-delivery-id",
  "idempotency-key",
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  "x-hub-signature-256",
] as const;

export interface Hook {
  id: string;
  key: string;
  enabled: boolean;
}

/** Shape-checks the host's `hooks` list; `null` when any entry is malformed. */
export function parseHooks(v: unknown, max: number): Hook[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: Hook[] = [];
  const seen = new Set<string>();
  for (const h of v) {
    if (!h || typeof h !== "object") return null;
    const { id, key, enabled } = h as Record<string, unknown>;
    if (typeof id !== "string" || !HOOK_ID.test(id) || seen.has(id)) return null;
    if (typeof key !== "string" || key.length < KEY_MIN || key.length > KEY_MAX) return null;
    if (typeof enabled !== "boolean") return null;
    seen.add(id);
    out.push({ id, key, enabled });
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function fromHex(s: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(s)) return null;
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Bearer key or `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(key, body)>`. */
export async function authorized(key: string, headers: Headers, body: Uint8Array): Promise<boolean> {
  const bearer = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
  if (bearer !== undefined && equal(utf8(bearer), utf8(key))) return true;
  const sig = /^sha256=([0-9a-fA-F]{64})$/.exec(headers.get("x-hub-signature-256") ?? "")?.[1];
  if (sig === undefined) return false;
  const mac = await crypto.subtle.importKey("raw", utf8(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", mac, fromHex(sig)!, body);
}

/**
 * The sender's delivery id (retries reuse it, so the queue and the host can drop duplicates), or a
 * fresh one. `null` when the sender's id is unusable.
 */
export function deliveryId(headers: Headers): string | null {
  const given = headers.get("x-delivery-id") ?? headers.get("x-github-delivery") ?? headers.get("idempotency-key");
  if (given === null) return crypto.randomUUID();
  return given.length > 0 && given.length <= DELIVERY_MAX && /^[\x21-\x7e]+$/.test(given) ? given : null;
}

export function forwarded(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}
