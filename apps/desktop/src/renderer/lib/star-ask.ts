/** How long after the first ask the second one waits, for people who kept using Codync. */
export const SECOND_ASK_AFTER = 7 * 24 * 60 * 60 * 1000

/** Where the GitHub star ask stands on this computer. */
export type StarAsk = { kind: 'never' } | { kind: 'asked'; at: number } | { kind: 'done' }

/** Which ask is due now: the first one right after setup, the second a week of use later. */
export function dueStarAsk(state: StarAsk, now: number): 'first' | 'second' | null {
  switch (state.kind) {
    case 'never':
      return 'first'
    case 'asked':
      return now - state.at >= SECOND_ASK_AFTER ? 'second' : null
    case 'done':
      return null
  }
}

/** Starring ends it; closing the first ask leaves room for the second, closing the second ends it. */
export function afterStarAsk(state: StarAsk, starred: boolean, now: number): StarAsk {
  return starred || state.kind !== 'never' ? { kind: 'done' } : { kind: 'asked', at: now }
}
