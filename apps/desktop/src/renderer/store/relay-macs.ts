import { macRole, type MacRole } from '@shared/mac-role'
import { askForAccess, accessText } from '@shared/relay-access'
import type { Computer } from '@shared/models'
import type { RelayComputer } from '@shared/relay'
import { HostError, RelayTransport, type HostClient } from '../client/host-client'
import { Observable, useModel } from '../lib/observable'
import { pref } from '../lib/prefs'
import { account } from './account'
import type { AppModel } from './app-model'
import { BotStore } from './bot-store'

/** Where asking one Mac for this device's access stands. */
export type MacAccess =
  | { kind: 'asking' }
  /** An owner compares these six digits with the ones on the Mac; a member is approved by the Mac without them. */
  | { kind: 'code'; code: string; compare: boolean }
  | { kind: 'failed'; message: string }

/** The Mac was reached before this device showed its invite. */
const UNPROVEN = /hasn't shown its invite/i
const ALREADY_PROVEN = /already shown its invite/i
export const OPEN_INVITE_LINK = 'Open the invite link on this computer.'

/** The Macs chosen on this device: the ones to keep connected. */
const chosen = pref<string[]>('relayMacs', [])

/**
 * Other Macs over the Kith cloud: the account's list (owned and member), and the ones connected on this device, each a
 * normal computer of the app model (`HostClient` over the relay). Loopback and SSH computers are not touched here.
 */
export class RelayMacs extends Observable {
  computers: RelayComputer[] = []
  error: string | null = null
  loaded = false
  access = new Map<string, MacAccess>()
  private attached = new Map<string, string>()
  private tokens = new Map<string, boolean>()
  private asking = new Map<string, { cancelled: boolean }>()
  private user: string | null = null

  constructor(private app: AppModel) {
    super()
    account.subscribe(() => this.noteAccount())
    this.noteAccount()
  }

  private noteAccount() {
    const user = account.user?.userId ?? null
    if (user === this.user) return
    this.user = user
    // Another account (or none) starts clean: nothing of the earlier one stays attached.
    for (const id of [...this.attached.keys()]) this.unattach(id)
    this.computers = []
    this.loaded = false
    this.changed()
    if (user) void this.refresh()
  }

  isChosen(id: string) {
    return chosen.get().includes(id)
  }

  /** The row for a Mac, from the account's list. */
  row(id: string) {
    return this.computers.find((c) => c.computerId === id) ?? null
  }

  store(id: string) {
    return this.attached.has(id) ? this.app.store(id) : null
  }

  /** The role on a Mac that is on this list: the connected store knows best, the cloud's row before that. */
  roleOf(id: string): MacRole {
    const store = this.store(id)
    if (store) return store.role
    return macRole({ granted: null, cloudRole: this.row(id)?.role ?? null, hasToken: this.tokens.get(id) ?? false })
  }

  async refresh() {
    if (!account.isSignedIn) return
    const res = await window.kith.relay.computers()
    if (res.ok) {
      this.computers = res.value
      this.error = null
      for (const c of res.value) if (!this.tokens.has(c.computerId)) this.tokens.set(c.computerId, !!(await window.kith.invites.kept(c.computerId)))
    } else {
      this.error = res.error.message ?? "Can't reach the Kith cloud."
    }
    this.loaded = true
    this.sync()
    this.changed()
  }

  /** Attaches the chosen Macs this device may connect to, and detaches the rest. */
  private sync() {
    const wanted = new Map<string, RelayComputer>()
    for (const id of chosen.get()) {
      const c = this.row(id)
      // Not on the list any more (removed from the account): nothing to connect to, nothing cached to keep.
      if (c && c.access === 'approved') wanted.set(id, c)
    }
    for (const id of [...this.attached.keys()]) if (!wanted.has(id)) this.unattach(id)
    for (const [id, c] of wanted) if (this.attached.get(id) !== c.signKey) this.attach(c)
  }

  private attach(c: RelayComputer) {
    const computer: Computer = { id: c.computerId, name: c.name, signKey: c.signKey, urls: [] }
    const store = new BotStore(computer, false, () => new RelayTransport(c.computerId, c.signKey))
    store.fixedRoute = 'relay'
    store.roleHint = { cloudRole: c.role, hasToken: this.tokens.get(c.computerId) ?? false }
    store.beforeConnect = (client) => this.showInvite(c.computerId, client)
    this.attached.set(c.computerId, c.signKey)
    this.app.attach(computer, store)
    // Access taken away on the Mac or the cloud (4003): say so, and drop what was cached from it.
    store.subscribe(() => {
      if (store.connection.kind === 'unauthorized' && store.hello) store.dropData()
    })
  }

  private unattach(id: string) {
    this.attached.delete(id)
    this.app.detach(id)
    void window.kith.relay.forget(id)
  }

  /** A device of an invited person shows its invite before anything else, on every connection. */
  private async showInvite(computerId: string, client: HostClient) {
    const kept = await window.kith.invites.kept(computerId)
    if (kept) {
      this.tokens.set(computerId, true)
      try {
        await client.proveInvite(kept.inviteId, kept.token)
      } catch (e) {
        if (!ALREADY_PROVEN.test(e instanceof Error ? e.message : '')) throw e
      }
      return
    }
    try {
      await client.hello()
    } catch (e) {
      if (e instanceof Error && UNPROVEN.test(e.message)) throw new HostError(403, OPEN_INVITE_LINK)
      // Any other answer is the normal path's to report.
    }
  }

  /** Connects a Mac: asks for access first when this device has none yet. Repeats while one is going are one request. */
  async connect(id: string) {
    const c = this.row(id)
    if (!c || this.asking.has(id)) return
    if (!chosen.get().includes(id)) chosen.set([...chosen.get(), id])
    if (c.access === 'approved') {
      // A store that gave up on "access removed" is replaced by a fresh one.
      if (this.store(id)?.connection.kind === 'unauthorized') this.unattach(id)
      void window.kith.relay.restart(id)
      this.sync()
      this.store(id)?.restartStream()
      return this.changed()
    }
    const mine = { cancelled: false }
    this.asking.set(id, mine)
    this.access.set(id, { kind: 'asking' })
    this.changed()
    try {
      const outcome = await askForAccess(window.kith.relay, c, {
        cancelled: () => mine.cancelled,
        onCode: (t) => {
          this.access.set(id, { kind: 'code', code: t.code, compare: c.role === 'owner' })
          this.changed()
        },
      })
      if (outcome === 'approved') {
        this.access.delete(id)
        await this.refresh()
        void window.kith.relay.restart(id)
      } else if (outcome === 'cancelled') this.access.delete(id)
      else this.access.set(id, { kind: 'failed', message: accessText(outcome) })
    } catch (e) {
      this.access.set(id, { kind: 'failed', message: e instanceof Error ? e.message : "Couldn't ask the Mac for access." })
    } finally {
      this.asking.delete(id)
      this.changed()
    }
  }

  cancel(id: string) {
    const mine = this.asking.get(id)
    if (mine) mine.cancelled = true
  }

  /** Stops using a Mac on this device: its channel closes, its cached chats go, and an invite kept for it is forgotten. */
  async disconnect(id: string) {
    this.cancel(id)
    chosen.set(chosen.get().filter((x) => x !== id))
    this.store(id)?.dropData()
    this.unattach(id)
    this.access.delete(id)
    if (this.tokens.get(id)) {
      this.tokens.set(id, false)
      try {
        await window.kith.invites.forget(id)
      } catch {}
    }
    this.changed()
  }

  /** The invitee's join finished: this Mac is one to keep connected. */
  async adopt(id: string) {
    if (!chosen.get().includes(id)) chosen.set([...chosen.get(), id])
    this.tokens.set(id, true)
    await this.refresh()
    this.store(id)?.restartStream()
  }
}

export function useRelayMacs(app: AppModel) {
  return useModel(app.relayMacs)
}
