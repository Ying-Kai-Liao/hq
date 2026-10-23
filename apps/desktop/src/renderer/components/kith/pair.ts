import type { CSSProperties } from 'react'
import { paletteColor } from '@shared/living-bots'

/** An agent's two-colour pair (the `kith:` palette): a thread's line, the "1 new" pill, a decision's buttons. */
export interface Pair {
  a: string
  b: string
}

/** For a bot with no palette pick (empty or an old bare id): a calm sky blue, never violet. */
export const FALLBACK_PAIR: Pair = { a: '#8fd0f7', b: '#5aa7e8' }

export function pairOf(avatarColor: string | undefined | null): Pair {
  const hit = paletteColor(avatarColor)
  return hit ? { a: hit.a, b: hit.b } : FALLBACK_PAIR
}

/** Sets `--pair-a` / `--pair-b` for kith.css to tint from. */
export const pairStyle = (pair: Pair): CSSProperties => ({ '--pair-a': pair.a, '--pair-b': pair.b }) as CSSProperties
