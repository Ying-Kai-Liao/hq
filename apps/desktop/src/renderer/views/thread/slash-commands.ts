// The composer's `/` commands, listed while the draft is just `/partial`: Fast mode and New
// session run here through host methods (`updateBot`, `newSession`); a skill fills in
// `/<id> `, and the host turns that message into "read this skill first"
// (host/src/market/skills.rs `expand_command`). docs/features/marketplace.md, "Commands".
import { fastModeDetail, fastModeShown, fastModeState } from '../../../shared/fast-mode.ts'
import type { Bot } from '../../../shared/models.ts'

/** The first host with `/skill` messages and skill details; older ones get the text as typed. */
export const SKILLS_HOST = '2.14.1'

export type SlashAction = { kind: 'fast' } | { kind: 'newSession' } | { kind: 'skill'; id: string }

export interface SlashCommand {
  /** What follows the `/`. */
  name: string
  icon: string
  title: string
  detail: string
  warning: boolean
  action: SlashAction
}

/** The command name being typed after a leading `/`, before any space; otherwise null. */
export function slashQuery(draft: string): string | null {
  return /^\/\S*$/.test(draft) ? draft.slice(1) : null
}

/** The bot's built-in commands; a group has none (each member has its own agent). */
function builtIn(bot: Bot): SlashCommand[] {
  if (bot.kind === 'group') return []
  const fast: SlashCommand[] = fastModeShown(bot)
    ? [{ name: 'fast', icon: 'bolt', title: 'Fast mode', detail: fastModeDetail(bot), warning: fastModeState(bot) === 'refused', action: { kind: 'fast' } }]
    : []
  return [
    ...fast,
    { name: 'new', icon: 'arrow.counterclockwise', title: 'New session', detail: 'Start over with a fresh context; the transcript stays', warning: false, action: { kind: 'newSession' } },
  ]
}

/** Built-in commands, then the bot's skills (ids in `bot.skills`), whose name or title holds `query`. */
export function slashCommands(bot: Bot | null, query: string, installedSkills: { id: string; name: string; description: string }[]): SlashCommand[] {
  if (!bot || bot.kind === 'group') return []
  const skills = installedSkills
    .filter((s) => bot.skills.includes(s.id))
    .map((s): SlashCommand => ({ name: s.id, icon: 'book.pages', title: s.name, detail: s.description, warning: false, action: { kind: 'skill', id: s.id } }))
  const q = query.toLowerCase()
  return [...builtIn(bot), ...skills].filter((c) => c.name.includes(q) || c.title.toLowerCase().includes(q))
}

/** A draft that is just a built-in command (`/fast`, `/new`): sending it runs the command. */
export function builtInCommand(bot: Bot | null, draft: string): SlashCommand | null {
  const name = slashQuery(draft.trim())
  return bot && name !== null ? (builtIn(bot).find((c) => c.name === name) ?? null) : null
}

/**
 * What Return does with `picked` highlighted: run it, except a skill whose name is already
 * typed out, which sends.
 */
export function returnRuns(picked: SlashCommand, draft: string): boolean {
  return picked.action.kind !== 'skill' || draft !== `/${picked.name}`
}
