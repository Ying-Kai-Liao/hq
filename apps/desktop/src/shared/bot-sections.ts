import type { KithInfo } from './kith-info.ts'

/**
 * Model, effort and permission controls always stay: Kith shows them read-only, so the control is the only way to
 * change them until hq becomes their one source (the next package).
 *
 * Which of Codync's own cards an hq bot's page still shows. The Kith sections (serve-bot-details) carry
 * the same facts, read from the agent's package, so each fact shows once and Kith's copy wins.
 * A card goes only once Kith has the fact on screen: while the details load, fail or are missing,
 * every card stays, and a plain bot (no `hqAgent`) always shows all of them.
 */
export interface BotSections {
  /** "Standing instructions": Kith's About shows the agent's role. */
  instructions: boolean
  /** The agent (backend) picker: Kith's Model & permissions shows the harness. */
  backendPicker: boolean
  /**
   * The harness's own notes tab in Memory. For an hq bot it is Claude Code's MEMORY.md of the bot's working
   * folder (the host's `projectMemory`), not the agent's memory: Kith's "Agent memory" lists the real files.
   * Gone for every hq bot, loaded or not.
   */
  harnessMemoryTab: boolean
}

export const ALL_SECTIONS: BotSections = { instructions: true, backendPicker: true, harnessMemoryTab: true }

export function botSections(
  hqAgent: string | null | undefined,
  info: Pick<KithInfo, 'description' | 'role' | 'harness' | 'errors'> | null,
): BotSections {
  if (!hqAgent) return ALL_SECTIONS
  if (!info) return { ...ALL_SECTIONS, harnessMemoryTab: false }
  return {
    instructions: !(info.role || info.description) || info.errors.role !== undefined,
    backendPicker: !info.harness,
    harnessMemoryTab: false,
  }
}
