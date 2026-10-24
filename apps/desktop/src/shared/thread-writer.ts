// Threads that start or go on in a terminal (host `terminal/sync.rs`). Origin and writer are open strings: a value
// this app doesn't know is still valid, and an unknown writer counts as holding the thread.
import type { Entry, ThreadSummary } from './models.ts'

export type ThreadOrigin = 'app' | 'terminal' | 'bot' | 'discord' | 'telegram' | 'slack' | { other: string }
export type WriterChange = 'startedInTerminal' | 'openedInTerminal' | 'tookOver' | 'terminalClosed' | { other: string }

const ORIGINS = ['terminal', 'bot', 'discord', 'telegram', 'slack'] as const
const CHANGES = ['startedInTerminal', 'openedInTerminal', 'tookOver', 'terminalClosed'] as const

export function threadOrigin(t: Pick<ThreadSummary, 'origin'> | undefined | null): ThreadOrigin {
  const o = t?.origin
  if (!o || o === 'app') return 'app'
  return (ORIGINS as readonly string[]).includes(o) ? (o as ThreadOrigin) : { other: o }
}

export function writerChange(data: { writerChange?: string } | undefined | null): WriterChange | null {
  const c = data?.writerChange
  if (!c) return null
  return (CHANGES as readonly string[]).includes(c) ? (c as WriterChange) : { other: c }
}

export const isTerminalOrigin = (t: Pick<ThreadSummary, 'origin'> | undefined | null) => t?.origin === 'terminal'

/** Someone other than the app holds the thread, so the app shows it read-only. An unknown writer counts as held. */
export const isHeldElsewhere = (t: Pick<ThreadSummary, 'liveWriter'> | undefined | null) => !!t?.liveWriter && t.liveWriter !== 'app'

/** A terminal is mid-turn in the thread: work the host's own lanes don't show, since the app isn't running it. */
export const isBusyInTerminal = (t: Pick<ThreadSummary, 'liveWriter' | 'liveBusy'> | undefined | null) => t?.liveWriter === 'terminal' && t.liveBusy === true

export const isHeldByTerminal = (t: Pick<ThreadSummary, 'liveWriter'> | undefined | null) => t?.liveWriter === 'terminal'

/** For a thread's root entry: the command that continues it in a terminal. */
export const resumeCommand = (agent: string, root: Pick<Entry, 'id'>) => `kith ${agent} --resume ${root.id}`

/** What `takeOverThread` answers; `tookOver` is false when there was nothing to take (closed already, or a second tap). */
export interface TakeOverResult {
  liveWriter: string | null
  tookOver: boolean
}

export type ThreadWriterCode = 'liveInTerminal' | 'heldByOtherWriter' | 'terminalBusy'

/** The refusal's code when a host error (HTTP 409, message starting with the code) is about who holds a thread. */
export function threadWriterCode(error: unknown): ThreadWriterCode | null {
  const e = error as { status?: number; message?: string } | null
  if (!e || e.status !== 409 || typeof e.message !== 'string') return null
  return (['liveInTerminal', 'heldByOtherWriter', 'terminalBusy'] as const).find((c) => e.message!.startsWith(c)) ?? null
}

/** The host's sentence without its code prefix. */
export const threadWriterMessage = (message: string) => message.replace(/^\w+:\s*/, '')
