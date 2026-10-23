// Pre-rename compatibility, delete with src/legacy-compat.ts: pairings, hosts and apps from before the Kith rename.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { LEGACY_LABEL, LEGACY_SIG_HEADER } from "../src/legacy-compat";
import { AUTHORITY, ORIGIN, call, clerkToken, env, newHost } from "./helpers";
import * as ref from "./ref";

describe("pre-rename clients", () => {
  it("still bounces the unsuffixed connector callbacks to the old app schemes", async () => {
    for (const [path, scheme] of [["", LEGACY_LABEL], ["/dev", `${LEGACY_LABEL}-dev`]]) {
      const res = await SELF.fetch(`${ORIGIN}/v1/oauth/callback${path}?code=abc&state=xyz`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${scheme}://oauth?code=abc&state=xyz`);
    }
  });

  it("still accepts the old signature header and signed prefix", async () => {
    const key = ref.signKey();
    const body = ref.enc.encode(JSON.stringify({ boxKey: ref.b64url(ref.boxKey().pub), name: "Mac", platform: "macos", version: "2.2.0" }));
    ref.useFamily(LEGACY_LABEL);
    let sig: string;
    try {
      sig = ref.signRequest(key, { method: "POST", authority: AUTHORITY, pathAndQuery: "/v1/host/register", body });
    } finally {
      ref.useFamily("kith");
    }
    const res = await worker.fetch(
      new Request(`https://${AUTHORITY}/v1/host/register`, { method: "POST", headers: { [LEGACY_SIG_HEADER]: sig }, body }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it("still accepts a claim a host signed under the old labels", async () => {
    const userId = `user_legacy_${ref.b64url(ref.random(4))}`;
    const token = await clerkToken(userId);
    const host = await newHost();
    const c = await call("POST", "/v1/claims", { token });
    expect(c.status).toBe(200);
    const boxKey = ref.b64url(host.box.pub);
    const canonical = ref.claimCanonical(c.body.claimId, c.body.nonce, userId, host.cid, boxKey, LEGACY_LABEL);
    const done = await call("POST", `/v1/claims/${c.body.claimId}/complete`, {
      token,
      body: {
        computerId: host.cid,
        signKey: ref.b64url(host.sign.pub),
        boxKey,
        name: "Studio",
        platform: "macos",
        device: "macmini",
        version: "2.2.0",
        sig: ref.b64url(ref.sign(host.sign, ref.enc.encode(canonical))),
      },
    });
    expect(done.status).toBe(200);
  });
});
