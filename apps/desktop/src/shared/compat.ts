// Phone/host compatibility: each side names the oldest protocol level of the other it still
// works with (docs/reference/compatibility.md). Mirrors host/src/compat.rs.

export type VersionMismatch = { kind: 'updateApp' } | { kind: 'updateHost'; version: string }

/** This app's protocol level, sent nowhere: the host's `minProtocol` is checked against it. */
export const PROTOCOL = 1
/** The oldest host protocol level this app works with. */
export const MIN_HOST_PROTOCOL = 1
/** A host from before protocol levels (no `protocol` in its hello) works with this app from this version. */
export const LEGACY_MIN_HOST = '2.12.0'

/** What a host's hello says about compatibility; a host without `protocol` predates 0.1.0. */
export interface HostVersion {
  version: string
  protocol?: number | null
  minProtocol?: number | null
}

/** `major.minor.patch`, ignoring a leading `v` and any pre-release or build suffix. */
export function parseVersion(version: string): number[] | null {
  let core = version.trim()
  if (core.startsWith('v')) core = core.slice(1)
  core = core.split('-')[0]!.split('+')[0]!
  const parts = core.split('.')
  if (parts.length < 1 || parts.length > 3) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null
    out.push(Number(part))
  }
  while (out.length < 3) out.push(0)
  return out
}

/** Whether `version` is below `minimum`; an unreadable version never is. */
export function isBelow(version: string, minimum: string): boolean {
  const v = parseVersion(version)
  const m = parseVersion(minimum)
  if (!v || !m) return false
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== m[i]!) return v[i]! < m[i]!
  }
  return false
}

/**
 * The side that must update. A legacy host is held to `LEGACY_MIN_HOST`; its `minApp` is not
 * checked, since every app with a protocol level is newer than any it names.
 */
export function checkHost(host: HostVersion, client = PROTOCOL, minHost = MIN_HOST_PROTOCOL): VersionMismatch | null {
  if (typeof host.protocol === 'number') {
    if (typeof host.minProtocol === 'number' && client < host.minProtocol) return { kind: 'updateApp' }
    if (host.protocol < minHost) return { kind: 'updateHost', version: host.version }
    return null
  }
  if (isBelow(host.version, LEGACY_MIN_HOST)) return { kind: 'updateHost', version: host.version }
  return null
}

/**
 * Whether a host has a feature that legacy hosts got in `legacyVersion`. Every host with a
 * protocol level has all of them; an unknown host is given the benefit of the doubt.
 */
export function hostHas(host: { version?: string; protocol?: number | null } | null | undefined, legacyVersion: string): boolean {
  if (!host || typeof host.protocol === 'number') return true
  return !isBelow(host.version ?? '', legacyVersion)
}
