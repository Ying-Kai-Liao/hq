/**
 * Bump when cached bots or entries gain a field the host only sends when they change: a cache with an
 * older schema is refetched in full on launch (2: bots carry `folder` and `project`).
 */
export const MIRROR_SCHEMA = 2

/** What a saved mirror is stamped with; a different stamp at the next launch refetches everything. */
export const mirrorStamp = (appVersion: string, hostVersion: string) => `${appVersion}/${hostVersion}/s${MIRROR_SCHEMA}`
