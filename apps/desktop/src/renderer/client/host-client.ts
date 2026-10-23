import type { CallError } from '@shared/ipc'
import { parseBackups, type Backups } from '@shared/backups'
import {
  parseDiff, parseHistory, parseMemoryList, parseRead, parseSave, parseTidyUps, parseUndo,
  type HqMemoryDiff, type HqMemoryList, type HqMemoryRead, type HqMemoryVersion, type HqSaveResult, type HqTidyUp, type HqUndoResult,
} from '@shared/hq-memory'
import { isUnsupportedHost, parseKithInfoResult, parseSearchResult, type KithInfoResult, type KithSearchResult } from '@shared/kith-info'
import type { PlaceFolder, PlaceSelection, ProjectInfo, RecentFolder, StartingFolder } from '@shared/place-folders'
import {
  normalizeBot,
  normalizeScreen,
  type AccessRequest,
  type Bot,
  type CloudStatus,
  type Entry,
  type Hello,
  type ScreenState,
  type Usage,
} from '@shared/models'

/** How a client reaches a host API. Only loopback today: the computer's own host or an SSH tunnel. */
export type HostRoute = 'loopback' | 'direct' | 'relay'

export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }

  static unreachable() {
    return new HostError(0, "Can't reach your computer. Is it on and connected to the internet?")
  }

  /** The link failed, not the request: the same call can work once the computer is reachable again. */
  get isTransient() {
    return this.status === 0
  }
}

export interface HostTransport {
  call(method: string, body: unknown, timeoutMs: number): Promise<unknown>
  /** Each element is one event's JSON (what SSE puts after `data:`). */
  stream(path: string, onData: (line: string) => void, onEnd: (error: HostError | null) => void): () => void
}

export class LoopbackTransport implements HostTransport {
  constructor(
    readonly baseURL: string,
    private token: string,
  ) {}

  async call(method: string, body: unknown, timeoutMs: number) {
    try {
      return await window.codync.host.call(this.baseURL, this.token, method, body, timeoutMs)
    } catch (e) {
      const error = e as CallError
      throw new HostError(error.status ?? 0, error.status === 401 ? "This device isn't allowed on that computer anymore." : error.message)
    }
  }

  stream(path: string, onData: (line: string) => void, onEnd: (error: HostError | null) => void) {
    return window.codync.host.stream(`${this.baseURL}${path}`, this.token, onData, (error) =>
      onEnd(error ? new HostError(error.status, error.message) : null),
    )
  }
}

export type HostEvent =
  | { type: 'hello'; hostId: string; rev: number; usage: Usage; screen: ScreenState | null }
  | { type: 'bot'; bot: Bot }
  | { type: 'botDeleted'; id: string; rev: number }
  | { type: 'entry'; entry: Entry }
  | { type: 'usage'; usage: Usage }
  | { type: 'screen'; screen: ScreenState }
  | { type: 'accessRequests'; requests: AccessRequest[] }
  | { type: 'cloud'; cloud: CloudStatus }
  | { type: 'resync' }
  /** An event this app version couldn't read (host newer/older than the app). */
  | { type: 'undecodable'; kind: string }

export function parseEvent(line: string): HostEvent | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const type = raw.type
  switch (type) {
    case 'hello':
      return {
        type,
        hostId: (raw.hostId as string) ?? '',
        rev: (raw.rev as number) ?? 0,
        usage: (raw.usage as Usage) ?? { providers: [] },
        screen: normalizeScreen(raw.screen as ScreenState | undefined),
      }
    case 'bot': {
      const bot = raw.bot as (Bot & { deleted?: boolean }) | undefined
      if (!bot || typeof bot.id !== 'string') return { type: 'undecodable', kind: 'bot' }
      if (bot.deleted) return { type: 'botDeleted', id: bot.id, rev: bot.rev ?? 0 }
      return { type, bot: normalizeBot(bot) }
    }
    case 'entry': {
      const entry = raw.entry as Entry | undefined
      if (!entry || typeof entry.id !== 'string' || typeof entry.botId !== 'string') return { type: 'undecodable', kind: 'entry' }
      return { type, entry: { ...entry, data: entry.data ?? {} } }
    }
    case 'usage':
      return raw.usage ? { type, usage: raw.usage as Usage } : null
    case 'screen': {
      const screen = normalizeScreen(raw.screen as ScreenState | undefined)
      return screen ? { type, screen } : null
    }
    case 'accessRequests':
      return { type, requests: (raw.requests as AccessRequest[]) ?? [] }
    case 'cloud':
      return raw.cloud ? { type, cloud: raw.cloud as CloudStatus } : null
    case 'resync':
      return { type }
    default:
      return null
  }
}

/** Typed host calls (host/src/api/); anything else goes through `call`. */
export class HostClient {
  readFile(entryId: string, fileId: string, offset: number): Promise<{ data: string; size: number }> {
    return this.call('readFile', { entryId, fileId, offset })
  }

  constructor(readonly transport: HostTransport) {}

  call<T>(method: string, body: unknown = {}, timeoutMs = 20_000): Promise<T> {
    return this.transport.call(method, body, timeoutMs) as Promise<T>
  }

  /** A method renamed with tidy-ups: a host from before the rename answers "unknown method" to the new name, so try `old` once. */
  async callRenamed<T>(method: string, old: string, body: unknown = {}, timeoutMs = 20_000): Promise<T> {
    try {
      return await this.call<T>(method, body, timeoutMs)
    } catch (error) {
      if (!isUnsupportedHost(error)) throw error
      return this.call<T>(old, body, timeoutMs)
    }
  }

  /** Catch-up since `since`, then live updates. */
  events(since: number, client: string, onEvent: (e: HostEvent) => void, onEnd: (error: HostError | null) => void) {
    const query = new URLSearchParams({ since: String(since), client })
    return this.transport.stream(`/events?${query}`, (line) => {
      const event = parseEvent(line)
      if (event) onEvent(event)
    }, onEnd)
  }

  hello() {
    return this.call<Hello>('hello').then((h) => ({ ...h, backends: h.backends ?? [], screen: normalizeScreen(h.screen) ?? undefined }))
  }

  async history(botId: string, beforeSeq: number, limit = 100) {
    return (await this.call<{ entries: Entry[] }>('history', { botId, beforeSeq, limit })).entries
  }

  /** `folder`: where the thread works; absent from a host without place folders. */
  async thread(botId: string, rootId: string) {
    return this.call<{ entries: Entry[]; folder?: unknown }>('thread', { botId, rootId })
  }

  async botConversation(botId: string, peerId: string) {
    return (await this.call<{ entries: Entry[] }>('botConversation', { botId, peerId })).entries
  }

  /** `pasted`: what the user pasted rather than typed, which memory never takes as their own words. */
  async send(botId: string, text: string, clientNonce: string, threadId: string | null, attachments: string[] | null, pasted: string[] = [], newTask = false, place: StartingFolder | null = null) {
    return (await this.call<{ entry: Entry }>('send', { botId, text, clientNonce, threadId, attachments, ...(pasted.length ? { pasted } : {}), ...(newTask ? { newTask } : {}), ...(place ?? {}) })).entry
  }

  /** Kith's project registry; without Kith the host answers `projects: []` and an `error` line. */
  projects(refresh = false) {
    return this.call<{ projects: ProjectInfo[]; error?: string }>('projects', refresh ? { refresh: true } : {}, 30_000)
  }

  /** A Kith bot's details from `kith <agent> --info-json`; `refresh` runs kith now instead of taking the host's 30 s copy. A host before this call answers 404. */
  async kithInfo(botId: string, refresh = false): Promise<KithInfoResult> {
    return parseKithInfoResult(await this.call('kithInfo', { botId, ...(refresh ? { refresh: true } : {}) }, 60_000))
  }

  /** Writes an hq bot's permission mode through to hq (`kith <agent> set permission`) and returns hq's info read back. */
  async kithSetPermission(botId: string, mode: string): Promise<KithInfoResult> {
    return parseKithInfoResult(await this.call('kithSetPermission', { botId, mode }, 60_000))
  }

  /** The backup chain: global order, per-agent orders and each entry's state. A host before this call answers 404. */
  async backups(): Promise<Backups> {
    return parseBackups(await this.call('backups', {}, 90_000))
  }

  /** Replaces a whole order: `agent` null is the global one; `chain` null drops the agent's own order. Answers like `backups`. */
  async backupsSet(agent: string | null, chain: string[] | null): Promise<Backups> {
    return parseBackups(await this.call('backupsSet', { agent, chain }, 90_000))
  }

  async kithMemorySearch(botId: string, query: string, limit = 30): Promise<KithSearchResult> {
    return parseSearchResult(await this.call('kithMemorySearch', { botId, query, limit }, 30_000))
  }

  // An hq agent's memory as files (`kithMemory*`, serve/docs/bot-info.md): `shared` is the user layer, `name` the path inside the layer.
  async hqMemoryList(botId: string): Promise<HqMemoryList> {
    return parseMemoryList(await this.call('kithMemoryList', { botId }, 30_000))
  }

  async hqMemoryRead(botId: string, shared: boolean, name: string): Promise<HqMemoryRead> {
    return parseRead(await this.call('kithMemoryRead', { botId, shared, name }, 30_000))
  }

  async hqMemorySave(botId: string, shared: boolean, name: string, text: string): Promise<HqSaveResult> {
    return parseSave(await this.call('kithMemorySave', { botId, shared, name, text }, 30_000))
  }

  async hqMemoryHistory(botId: string, shared: boolean, name: string, limit = 50): Promise<HqMemoryVersion[]> {
    return parseHistory(await this.call('kithMemoryHistory', { botId, shared, name, limit }, 30_000))
  }

  async hqMemoryDiff(botId: string, shared: boolean, name: string, from: number | null, to: number): Promise<HqMemoryDiff> {
    return parseDiff(await this.call('kithMemoryDiff', { botId, shared, name, ...(from !== null ? { from } : {}), to }, 30_000))
  }

  async hqMemoryRestore(botId: string, shared: boolean, name: string, version: number): Promise<HqSaveResult> {
    return parseSave(await this.call('kithMemoryRestore', { botId, shared, name, version }, 30_000))
  }

  async hqTidyUps(botId: string, limit = 20): Promise<HqTidyUp[]> {
    return parseTidyUps(await this.callRenamed('kithMemoryTidyUps', 'kithMemoryDreams', { botId, limit }, 30_000))
  }

  async hqUndoTidy(botId: string, id: number): Promise<HqUndoResult> {
    return parseUndo(await this.callRenamed('kithMemoryUndoTidy', 'kithMemoryUndoDream', { botId, id }, 30_000))
  }

  async recentFolders() {
    return (await this.call<{ folders: RecentFolder[] }>('recentFolders')).folders
  }

  async registerProject(id: string, path: string) {
    return (await this.call<{ project: ProjectInfo }>('registerProject', { id, path }, 30_000)).project
  }

  /** `threadId` is the thread's root message; `chat` a group's id (a member's lane). */
  setPlaceFolder(botId: string, selection: PlaceSelection, place: { threadId?: string | null; chat?: string } = {}) {
    return this.call<{ folder: PlaceFolder }>('setPlaceFolder', { botId, ...(place.threadId ? { threadId: place.threadId } : {}), ...(place.chat ? { chat: place.chat } : {}), ...selection }, 30_000)
  }

  /** Bytes per `upload` call: base64 of it stays well under the channel's 1 MiB message. */
  static uploadChunk = 384 * 1024

  async upload(botId: string, uploadId: string, name: string, data: Uint8Array) {
    let offset = 0
    do {
      const end = Math.min(offset + HostClient.uploadChunk, data.length)
      await this.call('upload', { botId, uploadId, name, data: toBase64(data.subarray(offset, end)), offset, done: end === data.length }, 60_000)
      offset = end
    } while (offset < data.length)
  }

  async readUpload(botId: string, uploadId: string) {
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const res = await this.call<{ data: string; size: number }>('readUpload', { botId, uploadId, offset: size }, 60_000)
      const chunk = fromBase64(res.data)
      if (!chunk.length) break
      parts.push(chunk)
      size += chunk.length
      if (size >= res.size) break
    }
    const out = new Uint8Array(size)
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}

export function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string) {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
