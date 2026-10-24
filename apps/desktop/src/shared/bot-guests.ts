/** Bot guests: bots from outside (Grok and the like) that an owner or an invited person invited (host methods `bots`, `myBots`, `decideBot`, ...; serve/host/src/api/botguests.rs). */

import type { MacRole } from './mac-role.ts'

export type BotState = 'invited' | 'joining' | 'pending' | 'active' | 'denied' | 'revoked'

export interface BotConversation {
  conversation: string
  agent: string
  chatBotId: string | null
  threadRoot: string | null
  originLabel: string
  lastAt: number | null
}

export interface BotGuest {
  botId: string
  name: string
  provider: string
  state: BotState
  /** The invited person who owns it; null when the computer's owner does. */
  ownerPerson: string | null
  ownerName: string | null
  agents: string[]
  limits: { ratePerHour: number; concurrent: number } | null
  connected: boolean
  createdAt: number
  joinedAt: number | null
  decidedAt: number | null
  /** `kai` (the computer's owner), `owner` (a person who owns the bot) or `auto`. */
  decidedBy: string | null
  lastSeenAt: number | null
  revokedAt: number | null
  /** Only in the owner's `bots` rows. */
  conversations: BotConversation[]
}

/** What `createBotInvite` answers with. `share` is the text to paste into the bot: shown, never kept. */
export interface CreatedBotInvite {
  botId: string
  inviteId: string
  expiresAt: number
  link: string
  kithLink: string
  share: string
}

const STATES: readonly string[] = ['invited', 'joining', 'pending', 'active', 'denied', 'revoked']

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/** A bot row or an event's bot; null when it has no id. Nullable fields stay null. */
export function parseBotGuest(raw: unknown): BotGuest | null {
  const r = rec(raw)
  const botId = str(r.botId)
  if (!botId) return null
  const limits = rec(r.limits)
  const rate = num(limits.ratePerHour)
  const concurrent = num(limits.concurrent)
  return {
    botId,
    name: str(r.name) || 'Bot',
    provider: str(r.provider),
    // A state this app doesn't know grants nothing: it reads as removed.
    state: STATES.includes(str(r.state)) ? (r.state as BotState) : 'revoked',
    ownerPerson: strOrNull(r.ownerPerson),
    ownerName: strOrNull(r.ownerName),
    agents: Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === 'string') : [],
    limits: rate !== null && concurrent !== null ? { ratePerHour: rate, concurrent } : null,
    connected: r.connected === true,
    createdAt: num(r.createdAt) ?? 0,
    joinedAt: num(r.joinedAt),
    decidedAt: num(r.decidedAt),
    decidedBy: strOrNull(r.decidedBy),
    lastSeenAt: num(r.lastSeenAt),
    revokedAt: num(r.revokedAt),
    conversations: (Array.isArray(r.conversations) ? r.conversations : []).map((c) => {
      const x = rec(c)
      return { conversation: str(x.conversation), agent: str(x.agent), chatBotId: strOrNull(x.chatBotId), threadRoot: strOrNull(x.threadRoot), originLabel: str(x.originLabel), lastAt: num(x.lastAt) }
    }),
  }
}

export function parseBotGuests(raw: unknown): BotGuest[] {
  const list = rec(raw).bots
  return (Array.isArray(list) ? list : []).map(parseBotGuest).filter((b): b is BotGuest => b !== null)
}

/** The `botRequest` event's bot: always waiting for the owner's answer. */
export const parseBotRequest = (raw: unknown): BotGuest | null => parseBotGuest({ ...rec(raw), state: 'pending' })

export function parseCreatedBotInvite(raw: unknown): CreatedBotInvite {
  const r = rec(raw)
  return { botId: str(r.botId), inviteId: str(r.inviteId), expiresAt: num(r.expiresAt) ?? 0, link: str(r.link), kithLink: str(r.kithLink), share: str(r.share) }
}

/** Bot invites are for the Grok app or any other. */
export type BotProvider = 'grok' | 'other'

const PROVIDERS: Record<string, string> = { grok: 'Grok', muse: 'Muse', dots: 'Dots', codex: 'Codex', cursor: 'Cursor' }

/** "Grok" for a known provider; null for `other` and anything unknown (no suffix is better than a wrong one). */
export const providerLabel = (provider: string): string | null => PROVIDERS[provider] ?? null

/** Which half of the feature this account uses on a Mac: the owner manages every bot, a member only their own; a guest has none. */
export function botGuestsMode(role: MacRole): 'owner' | 'member' | null {
  return role === 'owner' ? 'owner' : role === 'member' ? 'member' : null
}

/** Bots in a state that still counts (not folded into "Ended"). */
export const isLiveBot = (b: BotGuest) => b.state !== 'denied' && b.state !== 'revoked'

export const pendingBots = (bots: readonly BotGuest[]) => bots.filter((b) => b.state === 'pending')

/** The owner's own bots (nobody else owns them), and one person's. */
export const ownersOwn = (bots: readonly BotGuest[]) => bots.filter((b) => b.ownerPerson === null)
export const botsOf = (bots: readonly BotGuest[], personId: string) => bots.filter((b) => b.ownerPerson === personId)

/** "house", "house and notes", "house, notes and finance", "house, notes and 2 more". */
export function askList(agents: readonly string[]): string {
  if (agents.length <= 1) return agents[0] ?? 'nothing'
  if (agents.length === 2) return `${agents[0]} and ${agents[1]}`
  if (agents.length === 3) return `${agents[0]}, ${agents[1]} and ${agents[2]}`
  return `${agents[0]}, ${agents[1]} and ${agents.length - 2} more`
}

/** "Rex · Grok", or just "Rex". */
export const botTitle = (b: Pick<BotGuest, 'name' | 'provider'>) => [b.name, providerLabel(b.provider)].filter(Boolean).join(' · ')

/** "Sam's bot · Grok": the card's heading. */
export function cardHeading(b: BotGuest): string {
  const who = b.ownerName ? `${b.ownerName}'s bot` : 'Your bot'
  return [who, providerLabel(b.provider)].filter(Boolean).join(' · ')
}

/** "Rex wants to ask house and notes". */
export const cardQuestion = (b: BotGuest) => `${b.name} wants to ask ${askList(b.agents)}`

/** The "Always allow Sam's bots" button; null when the bot's owner isn't a person to remember. */
export const alwaysLabel = (b: BotGuest) => (b.ownerPerson && b.ownerName ? `Always allow ${b.ownerName}'s bots` : null)

/** What the card says after the answer. */
export function cardOutcome(decision: 'allow' | 'deny', always: boolean, b: BotGuest): string {
  if (decision === 'deny') return 'Denied'
  return always && b.ownerName ? `Allowed · ${b.ownerName}'s bots now join on their own` : 'Allowed'
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function ago(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

/** The age of a waiting request without "ago": "3 h", "2 days"; null under an hour. */
function waited(at: number, now: number): string | null {
  const h = Math.floor(Math.max(0, now - at) / 3_600_000)
  if (h < 1) return null
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

export type Trailing = 'cancel' | 'spinner' | 'decide' | 'chevron' | 'none'

export interface BotLine {
  /** Line 2 of the row. */
  line: string
  trailing: Trailing
  /** Waiting for you: the line is in ink with a dot. */
  emphasis: boolean
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * A bot's row: line 2 and what sits at the end, by state and by who is looking (the owner or the person whose bot it is).
 * `owner` is how the invitee names the computer's owner ("the owner of Mac mini"): the row's own `ownerName` is the invitee.
 */
export function botLine(b: BotGuest, view: 'owner' | 'invitee', now: number, owner = 'the owner'): BotLine {
  switch (b.state) {
    case 'invited':
      return { line: 'Invite not used yet', trailing: 'cancel', emphasis: false }
    case 'joining':
      return { line: 'Joining…', trailing: 'spinner', emphasis: false }
    case 'pending': {
      if (view === 'invitee') return { line: `Waiting for ${owner} to allow it`, trailing: 'none', emphasis: false }
      const age = waited(b.createdAt, now)
      return { line: age ? `Waiting for you · ${age}` : 'Waiting for you', trailing: 'decide', emphasis: true }
    }
    case 'active': {
      const seen = b.connected ? 'online now' : b.lastSeenAt ? `last asked ${ago(b.lastSeenAt, now)}` : 'not asked yet'
      return { line: `Asks ${b.agents.join(', ') || 'nothing'} · ${seen}`, trailing: 'chevron', emphasis: false }
    }
    case 'denied':
      return { line: view === 'owner' ? 'You said no' : `${capital(owner)} said no`, trailing: 'none', emphasis: false }
    case 'revoked':
      return { line: b.revokedAt ? `Removed ${ago(b.revokedAt, now)}` : 'Removed', trailing: 'none', emphasis: false }
  }
}

/** Who allowed it, for the detail's "Allowed by"; null while nobody has. `kai` is the computer's owner, `owner` the bot's own. */
export function allowedBy(b: BotGuest, view: 'owner' | 'invitee', owner = 'the owner'): string | null {
  if (!b.decidedBy) return null
  if (b.decidedBy === 'kai') return view === 'owner' ? 'You' : capital(owner)
  if (b.decidedBy === 'owner') return view === 'owner' ? (b.ownerName ?? 'Its owner') : 'You'
  return 'Automatically'
}

/** "Grok bot", or for the owner looking at a person's bot "Sam's Grok bot". */
export function detailSubtitle(b: BotGuest, view: 'owner' | 'invitee'): string {
  const provider = providerLabel(b.provider)
  const who = view === 'owner' && b.ownerName ? `${b.ownerName}'s ` : ''
  const text = `${who}${provider ? `${provider} ` : ''}bot`
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "in 5 min", "in 23 h", "in 2 days": how long until `at`; "now" once it has passed. */
export function inTime(at: number, now: number): string {
  const min = Math.floor((at - now) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `in ${h} h`
  return `in ${Math.floor(h / 24)} days`
}

/** "60 asks an hour · 2 at once": the limits line of the detail. */
export const limitsLine = (b: BotGuest) => (b.limits ? `${b.limits.ratePerHour} asks an hour · ${b.limits.concurrent} at once` : null)
