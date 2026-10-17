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
  /** Long-form files it added a line to. */
  files?: { name: string; shared: boolean; version: number }[]
}

/** A long-form memory file as the host last recorded it (`codync_mem::files::File`). */
export interface MemoryFile {
  bot: string | null
  name: string
  /** SHA-256 of what it holds; a save is made over it. */
  hash: string
  description: string | null
  tokens: number
  deleted: boolean
  updatedAt: number
}

export interface MemoryFiles {
  yours: { files: MemoryFile[]; folder: string }
  bot: { files: MemoryFile[]; folder: string }
  /** Tokens one file may hold, and files one folder may hold. */
  cap: number
  folderCap: number
}

export interface MemoryFileVersion {
  id: number
  /** null: the file was deleted. */
  content: string | null
  /** user · bot · dream · computer */
  author: string
  authorBot: string | null
  /** edit · delete · restore · undo · dream */
  cause: string
  at: number
}

/** A file as it is on disk now, with its recent versions. */
export interface MemoryFileDetail {
  file: string
  shared: boolean
  content: string | null
  hash: string | null
  path: string
  versions: MemoryFileVersion[]
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
  /** The long-form files of both layers. */
  files?: MemoryFiles
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

  /** A long-form file as it is now, with its versions. */
  async file(name: string, shared: boolean): Promise<MemoryFileDetail | null> {
    try {
      return await (await this.client()).call<MemoryFileDetail>('memoryFile', { botId: this.botId, file: name, shared })
    } catch (error) {
      this.error = message(error)
      this.changed()
      return null
    }
  }

  /** Saves (`content`), deletes (neither) or brings back `version` of a file, over what was loaded (`base`). */
  changeFile(name: string, shared: boolean, base: string | null, change: { content?: string; version?: number } = {}) {
    const method = change.version !== undefined ? 'restoreMemoryFile' : change.content !== undefined ? 'saveMemoryFile' : 'deleteMemoryFile'
    return this.mutate(method, { file: name, shared, base, ...change })
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

/** Who made a file's version and why, for its row. */
export function versionLabel(version: MemoryFileVersion, botName: (id: string | null) => string) {
  const by = version.author === 'user' ? 'You'
    : version.author === 'bot' ? botName(version.authorBot)
    : version.author === 'dream' ? 'Dreaming' : 'This computer'
  switch (version.cause) {
    case 'delete': return `${by} deleted it`
    case 'restore': return `${by} brought back a version`
    case 'undo': return `${by} undid a change`
    default: return `${by} changed it`
  }
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
