// Phone/host compatibility: each side names the oldest protocol level of the other it still
// works with (docs/reference/compatibility.md). Mirrors host/src/compat.rs.

export type VersionMismatch = { kind: 'updateApp' } | { kind: 'updateHost' }

/** This app's protocol level, sent nowhere: the host's `minProtocol` is checked against it. */
export const PROTOCOL = 1
/** The oldest host protocol level this app works with. */
export const MIN_HOST_PROTOCOL = 1
/** What a host's hello says about compatibility; a host without `protocol` is level 0. */
export interface HostVersion {
  version: string
  protocol?: number | null
  minProtocol?: number | null
}

/**
 * The side that must update, by protocol level alone. A host without `protocol` is level 0;
 * a missing `minProtocol` is no floor on the app.
 */
export function checkHost(host: HostVersion, client = PROTOCOL, minHost = MIN_HOST_PROTOCOL): VersionMismatch | null {
  if (typeof host.minProtocol === 'number' && client < host.minProtocol) return { kind: 'updateApp' }
  if ((host.protocol ?? 0) < minHost) return { kind: 'updateHost' }
  return null
}
