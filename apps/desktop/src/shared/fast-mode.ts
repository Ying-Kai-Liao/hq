// Fast mode in the chat (composer ⚡) and bot settings; the host reports what the agent
// offers (`fastModeSupport`, `fastModeIssue`): docs/features/marketplace.md, "Fast mode".
import type { Bot } from './models'

export type FastModeState = 'on' | 'off' | 'refused'

/** An agent bot whose agent offers Fast mode, or one that has it on (so it can be turned off). */
export function fastModeShown(bot: Bot | null): boolean {
  if (!bot || bot.kind === 'group') return false
  return bot.fastMode || bot.fastModeSupport === 'offered' || bot.fastModeSupport === 'refused'
}

export function fastModeState(bot: Bot): FastModeState {
  if (!bot.fastMode) return 'off'
  return bot.fastModeSupport === 'refused' ? 'refused' : 'on'
}

/** Why it isn't in effect, when the agent turned it off itself. */
export function fastModeRefusal(bot: Bot): string | null {
  if (fastModeState(bot) !== 'refused') return null
  return `The agent turned it off: ${bot.fastModeIssue ?? 'not available'}. Switch it off and on to try again.`
}

/** The composer button's tooltip and accessibility label. */
export function fastModeTitle(bot: Bot): string {
  switch (fastModeState(bot)) {
    case 'off':
      return 'Turn on Fast mode: faster replies, more usage'
    case 'on':
      return 'Turn off Fast mode'
    case 'refused':
      return `Fast mode is off. ${fastModeRefusal(bot)}`
  }
}
