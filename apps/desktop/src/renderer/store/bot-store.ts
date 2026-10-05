import { checkVersions, isBelow, type VersionMismatch } from '@shared/compat'
import {
  isChat,
  isWorking,
  needsInput,
  type AccessRequest,
  type Bot,
  type BotDraft,
  type CloudStatus,
  type Computer,
  type DirListing,
  type Entry,
  type GroupDraft,
  type Hello,
  type ScreenState,
  type Usage,
} from '@shared/models'
import { HostClient, HostError, type HostEvent, type HostRoute, type HostTransport } from '../client/host-client'
import { Observable } from '../lib/observable'
import { ComposerDrafts } from './composer-drafts'

export type Connection =
  | { kind: 'unpaired' }
  | { kind: 'connecting' }
  | { kind: 'online' }
  | { kind: 'computerOffline'; lastSeen: number | null }
  | { kind: 'offline'; message: string }
  | { kind: 'unauthorized'; message: string }

/** A file picked in the composer, sent with the next message. */
export interface OutgoingFile {
  id: string
  name: string
  data: Uint8Array
}

/** Anything larger is refused by the computer. */
export const MAX_FILE_SIZE = 100 * 1024 * 1024

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅']

const DROP_GRACE = 5000
const INITIAL_GRACE = 1000
const ACTION_PATIENCE = 20_000
const MISMATCH_RECHECK = 30_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const same = (a: Connection, b: Connection) => a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b)

/**
 * One computer's mirror (bots, transcripts), kept by one events stream (catch-up since
 * `rev`, then live). Port of kit's `BotStore`.
 */
export class BotStore extends Observable {
  computer: Computer
  connection: Connection = { kind: 'connecting' }
  hostRoute: HostRoute | null = null
  client: HostClient | null = null
  hello: Hello | null = null
  hostVersion: { version: string; minApp?: string | null } | null = null
  bots = new Map<string, Bot>()
  entries = new Map<string, Entry[]>()
  usage: Usage = { providers: [] }
  screen: ScreenState | null = null
  accessRequests: AccessRequest[] = []
  cloud: CloudStatus | null = null
  historyComplete = new Set<string>()
  routineDrafts = new Map<string, string>()
  private composerDrafts = new ComposerDrafts()
  subscribeComposerDrafts = this.composerDrafts.subscribe
  lastError: string | null = null
  /** A kit view selected a bot on this store (new chat, editor); the account picks it up. */
  selection: string | null = null
  /** Permission cards whose answer is on its way, with the chosen option. */
  answering = new Map<string, string>()

  onRosterChanged: (() => void) | null = null
  onComputerChanged: ((c: Computer) => void) | null = null

  private heldDrop: Connection | null = null
  private dropTimer: ReturnType<typeof setTimeout> | null = null
  private waiting = 0
  private rev = 0
  private hostId: string | null = null
  private retired = false
  private closeEvents: (() => void) | null = null
  private eventsLoop = 0
  private rewound = false
  private unreadable = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private outgoingFiles = new Map<string, OutgoingFile[]>()
  private readingViews = new Map<string, { botId: string; thread: string | null }>()
  private cacheStamp: string | null = null

  constructor(
    computer: Computer,
    readonly isLoopback: boolean,
    private makeTransport: () => HostTransport,
    private clientKind = 'mac',
    private appVersion = window.codync.appVersion,
    readonly contextId = 'local',
  ) {
    super()
    this.computer = computer
    this.loadCache()
  }

  // MARK: derived

  get isOffline() {
    const k = this.connection.kind
    return k === 'computerOffline' || k === 'offline' || k === 'unauthorized'
  }

  /** Loopback has no relay mailbox. */
  get canQueue() {
    return false
  }

  /** What headers show: a reconnect the grace period keeps quiet reads "Connecting…" while an action waits. */
  get shownConnection(): Connection {
    return this.waiting > 0 && this.connection.kind === 'online' ? { kind: 'connecting' } : this.connection
  }

  get hostName() {
    return this.hello?.name ?? this.computer.name
  }

  get mismatch(): VersionMismatch | null {
    if (!this.hostVersion) return null
    const found = checkVersions(this.appVersion, this.hostVersion.version, this.hostVersion.minApp)
    if (found) return found
    if (this.unreadable && isBelow(this.appVersion, this.hostVersion.version)) return { kind: 'updateApp', minimum: this.hostVersion.version }
    return null
  }

  /** Roster order: pinned first, then most recent activity. */
  get roster(): Bot[] {
    return [...this.bots.values()].filter((b) => !b.hidden).sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastAt - a.lastAt))
  }

  get hiddenBots(): Bot[] {
    return [...this.bots.values()].filter((b) => b.hidden).sort((a, b) => a.name.localeCompare(b.name))
  }

  backendName(id: string) {
    return this.hello?.backends.find((b) => b.id === id)?.name ?? builtInBackendName(id)
  }

  /** A bot's or group's main chat (thread replies are left out). */
  chat(botId: string) {
    return (this.entries.get(botId) ?? []).filter((e) => !e.threadId)
  }

  allEntries(botId: string) {
    return this.entries.get(botId) ?? []
  }

  replies(botId: string, root: string) {
    return (this.entries.get(botId) ?? []).filter((e) => e.threadId === root)
  }

  members(group: Bot) {
    return group.members.map((id) => this.bots.get(id)).filter((b): b is Bot => !!b)
  }

  authorName(id: string | null | undefined) {
    return (id && this.bots.get(id)?.name) || 'A deleted bot'
  }

  /** The latest thinking of the turn running in a chat (`thread` null) or thread. */
  currentThinking(botId: string, thread: string | null) {
    const list = this.allEntries(botId)
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!
      if ((e.threadId ?? null) !== thread) continue
      if (e.kind === 'user' || (e.kind === 'agent' && e.data.final === true)) return null
      if (e.kind === 'thought' && e.data.text) return e.data.text
    }
    return null
  }

  get connectionLabel() {
    switch (this.shownConnection.kind) {
      case 'online':
        return this.mismatch ? 'Needs update' : 'Connected'
      case 'connecting':
        return 'Connecting…'
      case 'computerOffline':
      case 'offline':
        return 'Offline'
      case 'unauthorized':
        return 'No access'
      case 'unpaired':
        return 'Not paired'
    }
  }

  updateComputer(change: (c: Computer) => Computer) {
    const next = change({ ...this.computer })
    if (JSON.stringify(next) === JSON.stringify(this.computer)) return
    this.computer = next
    this.onComputerChanged?.(next)
    this.changed()
  }

  // MARK: lifecycle

  retire() {
    this.retired = true
    this.composerDrafts.clear()
    this.stopTransport()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.onRosterChanged = null
    this.onComputerChanged = null
    this.client = null
    this.selection = null
  }

  start() {
    this.restartStream()
  }

  restartStream() {
    if (this.retired) return
    this.stopTransport()
    if (this.connection.kind !== 'online') this.setConnection({ kind: 'connecting' })
    const transport = this.makeTransport()
    this.client = new HostClient(transport)
    this.hostRoute = this.isLoopback ? 'loopback' : null
    this.runEvents(this.client)
  }

  private stopTransport() {
    this.eventsLoop++
    this.closeEvents?.()
    this.closeEvents = null
    if (this.dropTimer) clearTimeout(this.dropTimer)
    this.dropTimer = null
    this.heldDrop = null
  }

  /** Give initial connection failures a second to recover and online drops five seconds. */
  private setConnection(next: Connection) {
    const transient = next.kind === 'connecting' || next.kind === 'offline' || next.kind === 'computerOffline'
    const recovering = next.kind === 'online' && (this.connection.kind !== 'online' || this.heldDrop !== null)
    const initialFailure = this.connection.kind === 'connecting' && transient && next.kind !== 'connecting'
    if (transient && (this.connection.kind === 'online' || initialFailure)) {
      const grace = this.connection.kind === 'online' ? DROP_GRACE : INITIAL_GRACE
      this.heldDrop = next
      if (!this.dropTimer) {
        this.dropTimer = setTimeout(() => {
          this.dropTimer = null
          const held = this.heldDrop
          this.heldDrop = null
          if (held && !this.retired) {
            this.connection = held
            this.changed()
          }
        }, grace)
      }
      return
    }
    if (this.dropTimer) clearTimeout(this.dropTimer)
    this.dropTimer = null
    this.heldDrop = null
    if (!same(next, this.connection)) {
      this.connection = next
      this.changed()
    }
    if (recovering) for (const scope of this.readingViews.values()) this.markRead(scope.botId, scope.thread)
  }

  /** Events (catch-up since `rev`, then live) for as long as the store lives. */
  private runEvents(client: HostClient) {
    const loop = ++this.eventsLoop
    let backoff = 1000
    const alive = () => loop === this.eventsLoop && !this.retired
    const attempt = async () => {
      if (!alive()) return
      try {
        await this.refreshHello(client)
        if (!alive()) return
        if (this.mismatch) {
          this.setConnection({ kind: 'online' })
          await sleep(MISMATCH_RECHECK)
          return void attempt()
        }
        if (this.isLoopback) {
          try {
            this.accessRequests = (await client.call<{ requests: AccessRequest[] }>('accessRequests')).requests
          } catch {}
          try {
            this.cloud = await client.call<CloudStatus>('cloudStatus')
          } catch {}
          this.changed()
        }
        if (!alive()) return
        await new Promise<void>((resolve, reject) => {
          this.closeEvents = client.events(
            this.rev,
            this.clientKind,
            (event) => {
              if (!alive()) return
              this.setConnection({ kind: 'online' })
              backoff = 1000
              this.apply(event)
            },
            (error) => (error ? reject(error) : resolve()),
          )
        })
      } catch (error) {
        if (!alive()) return
        const message = error instanceof Error ? error.message : String(error)
        this.setConnection({ kind: 'offline', message })
        if (error instanceof HostError && error.status === 401) return
      }
      if (!alive()) return
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 20_000)
      void attempt()
    }
    void attempt()
  }

  /** Resubscribes from the current `rev` on the same link. */
  private restartEvents() {
    if (!this.client) return
    this.closeEvents?.()
    this.runEvents(this.client)
  }

  private async refreshHello(client: HostClient) {
    const h = await client.hello()
    if (this.retired) return
    this.hello = h
    this.noteHostVersion({ version: h.version, minApp: h.minApp })
    if (this.isLoopback) this.updateComputer((c) => ({ ...c, name: h.name, device: h.device ?? c.device }))
    this.changed()
  }

  private noteHostVersion(next: { version: string; minApp?: string | null }) {
    const cached = this.cacheStamp !== null && this.cacheStamp !== `${this.appVersion}/${next.version}`
    if (cached || (this.hostVersion && this.hostVersion.version !== next.version)) {
      // A different host version or app build: data may carry new fields, so fetch it all again.
      this.rev = 0
      this.rewound = false
      this.unreadable = false
    }
    this.cacheStamp = null
    this.hostVersion = next
  }

  private apply(event: HostEvent) {
    switch (event.type) {
      case 'hello':
        if (this.hostId && this.hostId !== event.hostId) this.resetMirror()
        this.hostId = event.hostId
        this.usage = event.usage
        this.screen = event.screen
        if (event.rev < this.rev) this.rev = 0
        break
      case 'bot':
        this.bots.set(event.bot.id, event.bot)
        this.bump(event.bot.rev)
        this.onRosterChanged?.()
        if (event.bot.unread > 0) this.acknowledgeVisible(event.bot.id)
        break
      case 'botDeleted':
        this.bots.delete(event.id)
        this.entries.delete(event.id)
        this.composerDrafts.deleteBot(event.id)
        this.bump(event.rev)
        if (this.selection === event.id) this.selection = null
        this.onRosterChanged?.()
        break
      case 'entry':
        this.upsert(event.entry)
        this.bump(event.entry.rev)
        this.acknowledgeVisible(event.entry.botId, event.entry)
        break
      case 'usage':
        this.usage = event.usage
        break
      case 'screen':
        this.screen = event.screen
        break
      case 'accessRequests':
        this.accessRequests = event.requests
        break
      case 'cloud':
        this.cloud = event.cloud
        break
      case 'resync':
        this.restartEvents()
        break
      case 'undecodable':
        // Never skip past data we couldn't read: rewind once and fetch everything again.
        if (!this.rewound) {
          this.rewound = true
          this.rev = 0
          this.restartEvents()
        } else if (!this.unreadable) {
          this.unreadable = true
          if (this.mismatch) this.restartEvents()
        }
        break
    }
    this.changed()
    this.scheduleSave()
  }

  private resetMirror() {
    this.bots = new Map()
    this.composerDrafts.clear()
    const kept = new Map<string, Entry[]>()
    for (const [id, list] of this.entries) {
      const local = list.filter((e) => e.id.startsWith('local-'))
      if (local.length) kept.set(id, local)
    }
    this.entries = kept
    this.selection = null
    this.onRosterChanged?.()
    this.rev = 0
    this.hostId = null
    this.historyComplete = new Set()
    this.screen = null
    this.saveCache()
  }

  private bump(r: number) {
    this.rev = Math.max(this.rev, r)
  }

  private upsert(e: Entry) {
    const list = [...(this.entries.get(e.botId) ?? [])]
    const i = list.findIndex((x) => x.id === e.id)
    if (i >= 0) {
      // A late API response mustn't undo a newer SSE update.
      if (e.rev < list[i]!.rev) return
      list[i] = e
    } else {
      // Replace the optimistic copy of a message we sent.
      const nonce = e.kind === 'user' ? e.data.clientNonce : undefined
      const filtered = nonce ? list.filter((x) => x.id !== `local-${nonce}`) : list
      const last = filtered[filtered.length - 1]
      if (last && last.seq > e.seq && e.seq > 0) {
        const at = filtered.findIndex((x) => x.seq > e.seq)
        filtered.splice(at < 0 ? filtered.length : at, 0, e)
      } else {
        filtered.push(e)
      }
      this.entries.set(e.botId, filtered)
      return
    }
    this.entries.set(e.botId, list)
  }

  // MARK: actions

  private get live(): HostClient | null {
    return this.connection.kind === 'online' && !this.heldDrop && !this.retired ? this.client : null
  }

  /** The client once the link is up. A reconnect in progress is waited out (headers show it). */
  async ready(deadline = Date.now() + ACTION_PATIENCE): Promise<HostClient> {
    let counted = false
    let retried = false
    try {
      while (!this.retired) {
        if (this.live) return this.live
        switch (this.connection.kind) {
          case 'online':
          case 'connecting':
            break
          case 'offline':
            if (!retried) {
              retried = true
              this.restartStream()
              break
            }
            throw HostError.unreachable()
          case 'unpaired':
            throw HostError.unreachable()
          case 'computerOffline':
            throw new HostError(0, 'Your computer is offline.')
          case 'unauthorized':
            throw new HostError(401, this.connection.message)
        }
        if (Date.now() >= deadline) break
        if (!counted) {
          counted = true
          this.waiting++
          this.changed()
        }
        await sleep(100)
      }
      throw HostError.unreachable()
    } finally {
      if (counted) {
        this.waiting--
        this.changed()
      }
    }
  }

  /** Runs `op` once the link is up; with `replay`, a call the link dropped under is tried again. */
  private async withLink<T>(op: (c: HostClient) => Promise<T>, replay = false): Promise<T> {
    const deadline = Date.now() + ACTION_PATIENCE
    for (;;) {
      const client = await this.ready(deadline)
      try {
        return await op(client)
      } catch (error) {
        if (replay && error instanceof HostError && error.isTransient && Date.now() < deadline) {
          await sleep(500)
          continue
        }
        throw error
      }
    }
  }

  private perform(op: (c: HostClient) => Promise<unknown>, replay = false) {
    void this.withLink(op, replay).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.changed()
    })
  }

  composerDraft(botId: string, thread: string | null = null) {
    return this.composerDrafts.get(botId, thread)
  }

  setComposerDraft(text: string, botId: string, thread: string | null = null) {
    if (!this.retired) this.composerDrafts.set(botId, thread, text)
  }

  sendComposerDraft(botId: string, thread: string | null = null, files: OutgoingFile[] = []) {
    if (this.retired) return false
    const text = this.composerDrafts.take(botId, thread, files.length > 0)
    if (text === null) return false
    this.send(text, botId, thread, files)
    return true
  }

  send(text: string, botId: string, thread: string | null = null, files: OutgoingFile[] = [], nonce: string = crypto.randomUUID()) {
    const trimmed = text.trim()
    if ((!trimmed && !files.length) || this.retired) return
    const data: Entry['data'] = { text: trimmed, status: 'sending', clientNonce: nonce }
    if (files.length) {
      data.attachments = files.map((f) => ({ id: f.id, name: f.name, size: f.data.length }))
      this.outgoingFiles.set(nonce, files)
    }
    this.upsert({
      id: `local-${nonce}`, seq: Number.MAX_SAFE_INTEGER, botId, threadId: thread, rev: 0, kind: 'user',
      turn: 0, data, createdAt: Date.now(), updatedAt: 0,
    })
    this.changed()
    void (async () => {
      try {
        // Safe to repeat: the computer skips a nonce it already has.
        const e = await this.withLink(async (client) => {
          let ids: string[] | null = null
          const pending = this.outgoingFiles.get(nonce)
          if (pending) {
            ids = []
            for (const file of pending) {
              const id = crypto.randomUUID()
              await client.upload(botId, id, file.name, file.data)
              cacheAttachment(id, file.data)
              ids.push(id)
            }
          }
          return client.send(botId, trimmed, nonce, thread, ids)
        }, true)
        this.outgoingFiles.delete(nonce)
        this.upsert(e)
        this.changed()
      } catch (error) {
        if (this.outgoingFiles.has(nonce)) this.lastError = `Couldn't send the files: ${error instanceof Error ? error.message : error}`
        this.markLocal(nonce, botId, 'failed')
      }
    })()
  }

  retry(entry: Entry) {
    const files = (entry.data.clientNonce && this.outgoingFiles.get(entry.data.clientNonce)) || []
    const text = entry.data.text ?? ''
    if (!text && !files.length) return
    this.entries.set(entry.botId, this.allEntries(entry.botId).filter((e) => e.id !== entry.id))
    this.send(text, entry.botId, entry.threadId ?? null, files, entry.data.clientNonce ?? crypto.randomUUID())
  }

  discard(entry: Entry) {
    if (entry.data.clientNonce) this.outgoingFiles.delete(entry.data.clientNonce)
    this.entries.set(entry.botId, this.allEntries(entry.botId).filter((e) => e.id !== entry.id))
    this.changed()
    this.scheduleSave()
  }

  cancelQueued(_entry: Entry) {
    // Loopback never queues in a relay mailbox.
  }

  private markLocal(nonce: string, botId: string, status: string) {
    const list = this.entries.get(botId)
    const i = list?.findIndex((e) => e.id === `local-${nonce}`) ?? -1
    if (!list || i < 0) return
    const next = [...list]
    next[i] = { ...next[i]!, data: { ...next[i]!.data, status } }
    this.entries.set(botId, next)
    this.changed()
    this.scheduleSave()
  }

  /** A sent file's bytes: cached after the first fetch (sent files never change). */
  async attachmentData(fileId: string, botId: string): Promise<Uint8Array | null> {
    const cached = attachmentCache.get(fileId)
    if (cached) return cached
    const client = this.live
    if (!client) return null
    try {
      const data = await client.readUpload(botId, fileId)
      cacheAttachment(fileId, data)
      return data
    } catch {
      return null
    }
  }

  stop(botId: string) {
    this.perform((c) => c.call('stop', { botId }), true)
  }

  newSession(botId: string) {
    this.perform((c) => c.call('newSession', { botId }))
  }

  logCall(botId: string, seconds: number) {
    this.perform((c) => c.call('logCall', { botId, seconds }))
  }

  screenTakeover(on: boolean) {
    this.perform(async (c) => {
      this.screen = await c.call<ScreenState>('screenTakeover', { on })
      this.changed()
    }, true)
  }

  /** Only the computer itself may turn remote screen on. */
  async setScreenEnabled(on: boolean) {
    this.screen = await (await this.ready()).call<ScreenState>('setScreenEnabled', { enabled: on })
    this.changed()
  }

  /** Toggles the user's reaction; shown at once, then replaced by the host's copy. */
  react(entry: Entry, emoji: string) {
    const list = this.entries.get(entry.botId)
    const i = list?.findIndex((e) => e.id === entry.id) ?? -1
    if (!list || i < 0) return
    const reactions = [...(list[i]!.data.reactions ?? [])]
    const at = reactions.indexOf(emoji)
    if (at >= 0) reactions.splice(at, 1)
    else reactions.push(emoji)
    const next = [...list]
    next[i] = { ...next[i]!, data: { ...next[i]!.data, reactions } }
    this.entries.set(entry.botId, next)
    this.changed()
    this.perform(async (c) => {
      const res = await c.call<{ entry: Entry }>('react', { entryId: entry.id, emoji })
      this.upsert(res.entry)
      this.changed()
    })
  }

  respond(entry: Entry, option: string | null) {
    if (this.answering.has(entry.id)) return
    this.answering.set(entry.id, option ?? '')
    this.changed()
    void (async () => {
      try {
        await this.withLink((c) => c.call('respondPermission', { entryId: entry.id, optionId: option }), true)
        // The card's own update follows on the events stream; hold the spinner until then.
        await sleep(2000)
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
      this.answering.delete(entry.id)
      this.changed()
    })()
  }

  /** Views register while visible. Multiple windows may read the same conversation. */
  setReading(token: string, botId: string, thread: string | null, active: boolean) {
    if (active) {
      this.readingViews.set(token, { botId, thread })
      if (this.connection.kind === 'online') this.markRead(botId, thread)
    } else {
      this.readingViews.delete(token)
    }
  }

  private acknowledgeVisible(botId: string, entry?: Entry) {
    if (this.connection.kind !== 'online') return
    const seen = new Set<string>()
    for (const scope of this.readingViews.values()) {
      if (scope.botId !== botId) continue
      if (entry && (!isChat(entry) || (entry.threadId ?? null) !== scope.thread)) continue
      const key = `${scope.botId}/${scope.thread}`
      if (seen.has(key)) continue
      seen.add(key)
      this.markRead(botId, scope.thread)
    }
  }

  markRead(botId: string, thread: string | null = null) {
    void (async () => {
      if (!this.live) await sleep(INITIAL_GRACE)
      const client = this.live
      if (!client) return
      try {
        await client.call('markRead', { botId, threadId: thread, all: false })
      } catch {
        // The visible scope is acknowledged again when the link recovers.
      }
    })()
  }

  /** The roster's "Mark as read": the chat and all its threads. */
  markAllRead(botId: string) {
    const bot = this.bots.get(botId)
    if (!bot || bot.unread <= 0) return
    this.bots.set(botId, { ...bot, unread: 0 })
    this.changed()
    this.perform((c) => c.call('markRead', { botId, threadId: null, all: true }), true)
  }

  private patchBot(bot: Bot, change: Partial<BotDraft>) {
    const current = this.bots.get(bot.id)
    if (current) this.bots.set(bot.id, { ...current, ...change } as Bot)
    this.changed()
    this.perform((c) => c.call('updateBot', { ...updatePayload(bot), ...change }), true)
  }

  setPinned(bot: Bot, pinned: boolean) {
    this.patchBot(bot, { pinned })
  }

  setHidden(bot: Bot, hidden: boolean) {
    this.patchBot(bot, { hidden })
  }

  delete(bot: Bot) {
    this.bots.delete(bot.id)
    this.entries.delete(bot.id)
    this.composerDrafts.deleteBot(bot.id)
    this.onRosterChanged?.()
    this.changed()
    this.perform((c) => c.call('deleteBot', { botId: bot.id }), true)
  }

  /** Creates a group chat (or opens the one these bots already share) and selects it. */
  async createGroup(name: string, description: string, members: string[]) {
    const draft: GroupDraft = { kind: 'group', name, description, members }
    const res = await (await this.ready()).call<{ bot: Bot }>('createBot', draft)
    this.bots.set(res.bot.id, res.bot)
    this.selection = res.bot.id
    this.onRosterChanged?.()
    this.changed()
    return res.bot
  }

  async updateGroup(draft: GroupDraft) {
    const res = await (await this.ready()).call<{ bot: Bot }>('updateBot', draft)
    this.bots.set(res.bot.id, res.bot)
    this.changed()
  }

  async loadThread(botId: string, root: string) {
    if (!this.client) return
    try {
      for (const e of await this.client.thread(botId, root)) this.upsert(e)
      this.changed()
    } catch {}
  }

  async save(draft: BotDraft) {
    const client = await this.ready()
    const res = draft.id
      ? await client.call<{ bot: Bot }>('updateBot', { ...draft, model: draft.model ?? null })
      : await client.call<{ bot: Bot }>('createBot', draft)
    this.bots.set(res.bot.id, res.bot)
    this.onRosterChanged?.()
    this.changed()
    return res.bot
  }

  async refreshBackends() {
    if (!this.client || !this.hello) return
    try {
      const res = await this.client.call<{ backends: Hello['backends'] }>('refreshBackends', {}, 60_000)
      this.hello = { ...this.hello, backends: res.backends }
      this.changed()
    } catch {}
  }

  async listDirs(path: string | null) {
    return (await this.ready()).call<DirListing>('listDirs', { path })
  }

  async refreshUsage() {
    if (this.retired || !this.client) return
    try {
      this.usage = await this.client.call<Usage>('usage', { refresh: true })
      this.changed()
    } catch {}
  }

  async loadOlder(botId: string) {
    if (!this.client || this.historyComplete.has(botId)) return
    const first = this.chat(botId).find((e) => e.seq > 0 && e.seq !== Number.MAX_SAFE_INTEGER)?.seq ?? Number.MAX_SAFE_INTEGER
    try {
      const older = await this.client.history(botId, first, 100)
      if (older.length < 100) this.historyComplete.add(botId)
      for (const e of older) this.upsert(e)
      this.changed()
    } catch {}
  }

  setError(message: string | null) {
    this.lastError = message
    this.changed()
  }

  setSelection(id: string | null) {
    this.selection = id
    this.changed()
  }

  consumeRoutineDraft(botId: string) {
    const value = this.routineDrafts.get(botId)
    if (value !== undefined) {
      this.routineDrafts.delete(botId)
      this.changed()
    }
    return value
  }

  setRoutineDraft(botId: string, text: string) {
    this.routineDrafts.set(botId, text)
    this.changed()
  }

  // MARK: cache (instant launch, offline reading)

  private get cacheKey() {
    return `codync-mirror-${this.contextId}-${this.computer.id}`
  }

  private loadCache() {
    try {
      const raw = localStorage.getItem(this.cacheKey)
      if (!raw) return
      const cache = JSON.parse(raw) as { stamp?: string; hostId?: string; rev: number; bots: Bot[]; entries: Entry[] }
      this.cacheStamp = cache.stamp ?? ''
      this.hostId = cache.hostId ?? null
      this.rev = cache.rev
      this.bots = new Map(cache.bots.map((b) => [b.id, b]))
      const grouped = new Map<string, Entry[]>()
      for (const e of cache.entries) grouped.set(e.botId, [...(grouped.get(e.botId) ?? []), e])
      this.entries = grouped
    } catch {}
  }

  private scheduleSave() {
    if (this.retired) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveCache(), 2000)
  }

  saveCache() {
    if (this.retired) return
    // Keep the newest 200 entries per bot; older ones page in from the host.
    const kept: Entry[] = []
    for (const list of this.entries.values()) {
      kept.push(...list.filter((e) => !e.id.startsWith('local-')).slice(-200))
      kept.push(...list.filter((e) => e.id.startsWith('local-') && e.data.status === 'failed'))
    }
    const cache = { stamp: `${this.appVersion}/${this.hello?.version ?? ''}`, hostId: this.hostId, rev: this.rev, bots: [...this.bots.values()], entries: kept }
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify(cache))
    } catch {}
  }
}

/** A full editor update must explicitly clear a previous model override. */
function updatePayload(bot: Bot): BotDraft {
  return {
    id: bot.id, name: bot.name, description: bot.description, avatarColor: bot.avatarColor, avatarShape: bot.avatarShape,
    backend: bot.backend, command: bot.command ?? null, cwd: bot.managedWorkspace ? '' : bot.cwd, permission: bot.permission,
    model: bot.model ?? null, pinned: bot.pinned, hidden: bot.hidden, notify: bot.notify ?? null,
    connectors: bot.connectors, skills: bot.skills, computer: bot.computer,
  }
}

export function builtInBackendName(id: string) {
  switch (id) {
    case 'claude':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'OpenCode'
    case 'grok':
      return 'Grok Build'
    case 'gemini':
      return 'Gemini CLI'
    default:
      return 'Custom agent'
  }
}

// ponytail: in-memory attachment cache; a disk cache (main process) if relaunches refetching hurts.
const attachmentCache = new Map<string, Uint8Array>()
function cacheAttachment(id: string, data: Uint8Array) {
  attachmentCache.set(id, data)
}

export { isWorking, needsInput }
