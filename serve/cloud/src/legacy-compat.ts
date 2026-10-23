// Pre-rename compatibility: delete after every paired device and every installed app has moved to the Kith names
// (devices re-paired, hosts and apps updated past PR #38). Nothing outside this file spells the old identifiers.

import type { Ctx } from "./routes/common";

/** Domain-separation family of pairings made before the rename (`<family>/hs1/v1`, `<family>-sig-v1`, `<family>/claim/v1`). */
export const LEGACY_LABEL = "codync";

/** The request-signature header older hosts and apps still send. */
export const LEGACY_SIG_HEADER = "Codync-Sig";

/**
 * Where a connector's sign-in page returns for apps installed before the rename; they only wait on these URL schemes.
 * Stateless, like the Kith routes: the query (code, state or error) is bounced to the app.
 */
const legacyBounce = (scheme: string) => async (c: Ctx) =>
  new Response(null, { status: 302, headers: { Location: `${scheme}://oauth${c.url.search}`, "Cache-Control": "no-store" } });

export const oauthLegacyCallback = legacyBounce("codync");
export const oauthLegacyDevCallback = legacyBounce("codync-dev");
