import type { EntryData } from '@shared/models'

/** A "Voice chat" line older than this with no length is a call that ended without saying so. */
export const CALL_LIVE_HOURS = 3

/**
 * The tail of a "Voice chat" notice: " · 00:16" once the call is over, " · in progress" while it may still be going,
 * nothing for a line that never got its length (app killed mid call) once it is stale. null: not a voice call line.
 */
export function callLineSuffix(data: Pick<EntryData, 'callSeconds' | 'callLive'>, createdAt: number, now = Date.now()): string | null {
  const s = data.callSeconds
  if (s !== undefined) return ` · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  if (!data.callLive) return null
  return now - createdAt < CALL_LIVE_HOURS * 3600_000 ? ' · in progress' : ''
}
