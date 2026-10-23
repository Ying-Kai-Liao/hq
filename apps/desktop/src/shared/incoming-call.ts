import type { Bot } from './models'

/**
 * An agent calling the person: the host's `call` event while it rings, and what the apps keep of it.
 * A call is on screen from the event that says `ringing` until any event settles it (answered on a device,
 * declined, missed) or its ring runs out here. No push: only an open, connected app ever hears it.
 */

export interface IncomingCall {
  id: string
  botId: string
  /** The thread the agent called from, when it did. */
  threadId: string | null
  name: string
  reason: string
  /** When this app stops showing it (Date.now() ms), from the host's remaining time so clock skew doesn't matter. */
  deadline: number
}

/** The call the event carries while it rings; null for a settled one or one this app can't read. */
export function parseCall(raw: unknown, now = Date.now()): { call: IncomingCall; ringing: boolean } | null {
  const c = (raw as { call?: Record<string, unknown> } | null)?.call
  if (!c || typeof c.id !== 'string' || typeof c.botId !== 'string') return null
  const remaining = typeof c.remainingMs === 'number' ? c.remainingMs : 45_000
  return {
    ringing: c.state === 'ringing',
    call: {
      id: c.id,
      botId: c.botId,
      threadId: typeof c.threadId === 'string' ? c.threadId : null,
      name: typeof c.name === 'string' ? c.name : '',
      reason: typeof c.reason === 'string' ? c.reason : '',
      deadline: now + Math.max(0, remaining),
    },
  }
}

/** The calls on screen after an event: a ringing call is added (once), any other state takes it away. */
export function reduceCalls(calls: IncomingCall[], event: { call: IncomingCall; ringing: boolean }): IncomingCall[] {
  const rest = calls.filter((c) => c.id !== event.call.id)
  if (!event.ringing) return rest
  const known = calls.find((c) => c.id === event.call.id)
  return [...rest, known ?? event.call]
}

/** Drops the calls whose ring is over. */
export function expireCalls(calls: IncomingCall[], now = Date.now()): IncomingCall[] {
  return calls.some((c) => c.deadline <= now) ? calls.filter((c) => c.deadline > now) : calls
}

/** What the floating incoming-call panel shows (main/incoming-call.ts): sent by the chat window, which owns the call. */
export interface IncomingPanelCall {
  id: string
  name: string
  reason: string
  /** The bot to draw (the panel has no store of its own); null draws no avatar. */
  bot: Bot | null
  /** When the panel closes itself (Date.now() ms), in case the chat window never says. */
  deadline: number
}

export type CallAnswer = 'accept' | 'decline'

/** The panel's call from what the renderer sent; null when it isn't one (the renderer is not trusted with the main process). */
export function parsePanelCall(raw: unknown): IncomingPanelCall | null {
  const c = raw as Partial<IncomingPanelCall> | null
  if (!c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || typeof c.deadline !== 'number') return null
  const bot = c.bot && typeof c.bot === 'object' && typeof (c.bot as Bot).id === 'string' ? (c.bot as Bot) : null
  return { id: c.id, name: c.name.slice(0, 120), reason: typeof c.reason === 'string' ? c.reason.slice(0, 400) : '', bot, deadline: c.deadline }
}

export const isCallAnswer = (v: unknown): v is CallAnswer => v === 'accept' || v === 'decline'
