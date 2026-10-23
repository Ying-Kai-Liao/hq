import type { KithInfo } from './kith-info.ts'

/**
 * Which of Kith's own cards an hq bot's page still shows. The Kith sections (serve-bot-details) carry
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
  /**
   * Kith's own permission, model, effort and Fast mode controls. hq is the one source for an hq bot's settings (the
   * host ignores its stored copy), so they go and the `hqSettings` rows take their place. A host that predates the
   * `kithInfo` call can't serve those, so the controls stay there.
   */
  kithSettings: boolean
}

export const ALL_SECTIONS: BotSections = { instructions: true, backendPicker: true, harnessMemoryTab: true, kithSettings: true }

export function botSections(
  hqAgent: string | null | undefined,
  info: Pick<KithInfo, 'description' | 'role' | 'harness' | 'errors'> | null,
  unsupportedHost = false,
): BotSections {
  if (!hqAgent) return ALL_SECTIONS
  const kithSettings = unsupportedHost
  if (!info) return { ...ALL_SECTIONS, harnessMemoryTab: false, kithSettings }
  return {
    instructions: !(info.role || info.description) || info.errors.role !== undefined,
    backendPicker: !info.harness,
    harnessMemoryTab: false,
    kithSettings,
  }
}

/** Permission modes hq knows (kernel/lib/kith_settings.py CHOICES), in the order the picker lists them. */
export const PERMISSION_MODES: { id: string; label: string }[] = [
  { id: 'default', label: 'Ask for each tool' },
  { id: 'manual', label: 'Manual' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan only' },
  { id: 'auto', label: 'Auto' },
  { id: 'dontAsk', label: "Don't ask" },
  { id: 'bypassPermissions', label: 'Bypass permissions' },
]

/** What a voice call can run on (`kith <agent> set call-model`): kith's default is sonnet, `own` is the agent's own model. */
export const CALL_MODELS: { id: string; label: string }[] = [
  { id: 'default', label: 'Default (sonnet)' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
  { id: 'own', label: "Agent's own model" },
]

export interface HqSetting {
  key: 'permission' | 'callModel' | 'model' | 'effort' | 'fastMode'
  label: string
  /** What hq reports, or plain words when it has nothing. */
  value: string
  /** Written through to hq. The rest hq has no setting for: read-only, "Set in Kith". */
  editable: boolean
  hint: string
}

export const SET_IN_KITH = 'Set in Kith'

/**
 * The settings of an hq bot, once, read from hq (`info` is `kith <agent> --info-json`; null while it loads or failed).
 * Only the permission mode has an hq setting to write to (`kith <agent> set permission`); the model and effort are the
 * agent package's own, and hq has no Fast mode.
 */
export function hqSettings(info: Pick<KithInfo, 'permissionMode' | 'callModel' | 'model' | 'effort'> | null): HqSetting[] {
  return [
    {
      key: 'permission', label: 'Permissions', editable: info !== null,
      value: info ? (info.permissionMode ?? 'auto') : '…',
      hint: 'Kept by Kith on this computer. Every chat of this agent uses it from its next turn.',
    },
    {
      key: 'callModel', label: 'Call model', editable: info !== null,
      value: info ? (info.callModel ?? 'default') : '…',
      hint: 'The model that answers when you talk to this agent in a voice call. Typed messages use the agent\'s own model.',
    },
    { key: 'model', label: 'Model', editable: false, value: info?.model ?? "Agent's default", hint: `${SET_IN_KITH}: the agent's package picks it.` },
    { key: 'effort', label: 'Effort', editable: false, value: info?.effort ?? "Agent's default", hint: `${SET_IN_KITH}: the agent's package picks it.` },
    { key: 'fastMode', label: 'Fast mode', editable: false, value: 'Off', hint: `${SET_IN_KITH}: hq has no Fast mode.` },
  ]
}

/** The picker's label for a call model id; one this app doesn't know shows as it is. */
export function callModelLabel(id: string): string {
  return CALL_MODELS.find((m) => m.id === id)?.label ?? id
}

/** The picker's label for a mode id; an id this app doesn't know shows as it is. */
export function permissionLabel(mode: string): string {
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode
}
