import type { HostClient } from '../client/host-client'
import { Observable } from '../lib/observable'

/** One memory entry (the host's `codync_mem::store::Entry`). */
export interface MemoryEntry {
  id: number
  /** The bot whose own layer holds it; null for what all bots share. */
  bot: string | null
  state: 'active' | 'archived' | string
  text: string
  /** user · bot · dream · imported */
  author: string
  authorBot: string | null
  pinned: boolean
  evidence: string[]
  createdAt: number
  updatedAt: number
}

export interface MemoryLayer { entries: MemoryEntry[]; used: number; cap: number }

/** One dreaming run: what it added and archived; it can be undone. */
export interface DreamRun {
  id: number
  at: number
  undone: boolean
  added: { id: number; text: string }[]
  archived: { id: number; text: string }[]
}

export interface MemoryView {
  /** Whether this bot uses what all bots share. */
  shared: boolean
  yours: MemoryLayer
  bot: MemoryLayer
  dreams: DreamRun[]
  /** Claude Code's own notes for the bot's project folder, read-only. */
  projectMemory: { path: string; text: string } | null
  memoryRev: number
}

/** One bot's memory: fetches it, and changes it through the host. */
export class MemoryStore extends Observable {
  view: MemoryView | null = null
  busy = false
  error: string | null = null
  private request = 0

  constructor(readonly botId: string, private readonly client: () => Promise<HostClient>) { super() }

  async load() {
    const request = ++this.request
    try {
      const view = await (await this.client()).call<MemoryView>('memory', { botId: this.botId })
      if (request === this.request) {
        this.view = view
        this.error = null
      }
    } catch (error) {
      if (request === this.request) this.error = message(error)
    }
    this.changed()
  }

  /** A memory method for this bot; reloads after it. */
  async mutate(method: string, body: object = {}) {
    if (this.busy) return false
    this.busy = true
    this.error = null
    this.changed()
    try {
      await (await this.client()).call(method, { botId: this.botId, ...body })
      await this.load()
      return true
    } catch (error) {
      this.error = message(error)
      return false
    } finally {
      this.busy = false
      this.changed()
    }
  }
}

/** Who wrote an entry, for its detail line. */
export function authorLabel(entry: MemoryEntry, botName: (id: string | null) => string) {
  switch (entry.author) {
    case 'user': return 'You wrote it'
    case 'bot': return `${botName(entry.authorBot)} remembered it`
    case 'dream': return 'Dreaming'
    default: return 'Moved from the old memory'
  }
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
