import { botGuestsMode, cardOutcome, pendingBots, type BotGuest, type BotProvider, type CreatedBotInvite } from '@shared/bot-guests'
import { isUnsupportedHost } from '@shared/kith-info'
import type { HostClient } from '../client/host-client'
import { Observable } from '../lib/observable'
import type { BotStore } from './bot-store'
import { peopleFor } from './people-store'

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e))

/** How long an answered card keeps its outcome ("Allowed") before it leaves. */
const OUTCOME_MS = 2500

/**
 * The bots from outside on one computer: for its owner every bot (`bots`), for an invited member their own (`myBots`).
 * The host's events only say that something changed, so each one reads the list again; the cards for waiting bots
 * therefore come back after a restart. The invite's share text is returned to the caller and kept nowhere here.
 */
export class BotGuestsModel extends Observable {
  /** null until the host answered once; false for a host before bot guests (everything about them hides). */
  supported: boolean | null = null
  bots: BotGuest[] = []
  error: string | null = null
  busy = false
  /** Bots with a decision, removal or new link in flight: their buttons disable. */
  working = new Set<string>()
  /** Cards just answered: the outcome shows for a moment, until the refreshed list drops them. */
  answered = new Map<string, { bot: BotGuest; outcome: string }>()
  /** Re-renders what follows this model but doesn't use it (the sidebar, the tray); set by the app model. */
  onChange: (() => void) | null = null

  constructor(private store: BotStore) {
    super()
  }

  protected override changed() {
    super.changed()
    this.onChange?.()
  }

  /** The half of the feature this account uses here, null when this host or role has none. */
  get mode() {
    return this.supported === false ? null : botGuestsMode(this.store.role)
  }

  /** Waiting for the owner's answer: the cards, oldest first. Only an owner's list ever holds other people's. */
  get pending(): BotGuest[] {
    return this.mode === 'owner' ? pendingBots(this.bots).sort((a, b) => a.createdAt - b.createdAt) : []
  }

  /** Pending plus the ones answered a moment ago, for the cards. */
  get cards(): { bot: BotGuest; outcome: string | null }[] {
    const waiting = this.pending.map((bot) => ({ bot, outcome: this.answered.get(bot.botId)?.outcome ?? null }))
    const shown = new Set(waiting.map((c) => c.bot.botId))
    return [...waiting, ...[...this.answered.values()].filter((a) => !shown.has(a.bot.botId))]
  }

  /** Reads the list for this role; the first answer says whether this host knows bots at all. */
  async load() {
    const mode = botGuestsMode(this.store.role)
    const client = this.store.client
    if (!mode || !client || this.store.connection.kind === 'offline') return
    try {
      this.bots = mode === 'owner' ? await client.bots() : await client.myBots()
      this.supported = true
      this.error = null
    } catch (e) {
      if (isUnsupportedHost(e)) {
        this.supported = false
        this.bots = []
      } else if (this.supported !== false) this.error = message(e)
    }
    this.changed()
  }

  private async run<T>(botId: string | null, work: (client: HostClient) => Promise<T>): Promise<T | null> {
    if (botId ? this.working.has(botId) : this.busy) return null
    if (botId) this.working.add(botId)
    else this.busy = true
    this.error = null
    this.changed()
    try {
      return await work(await this.store.ready())
    } catch (e) {
      this.error = message(e)
      return null
    } finally {
      if (botId) this.working.delete(botId)
      else this.busy = false
      this.changed()
    }
  }

  /** A bot and its invite; null when it failed (the reason is in `error`). A second call while one is running does nothing. */
  async invite(input: { name: string; provider: BotProvider; agents: string[] }): Promise<CreatedBotInvite | null> {
    const made = await this.run(null, (c) => c.createBotInvite(input))
    if (made) await this.load()
    return made
  }

  /** A fresh link for a bot that exists (its old invite lapsed or its VM was rebuilt). */
  async renew(bot: BotGuest): Promise<CreatedBotInvite | null> {
    const made = await this.run(bot.botId, (c) => c.createBotInvite({ name: bot.name, provider: bot.provider === 'grok' ? 'grok' : 'other', agents: bot.agents, botId: bot.botId }))
    if (made) await this.load()
    return made
  }

  async decide(bot: BotGuest, decision: 'allow' | 'deny', always = false) {
    const done = await this.run(bot.botId, (c) => c.decideBot(bot.botId, decision, always))
    if (done === null) return
    this.answered.set(bot.botId, { bot, outcome: cardOutcome(decision, always, bot) })
    setTimeout(() => {
      this.answered.delete(bot.botId)
      this.changed()
    }, OUTCOME_MS)
    await this.load()
    if (always) await peopleFor(this.store).load()
  }

  async revoke(botId: string) {
    if ((await this.run(botId, (c) => c.revokeBot(botId))) !== null) await this.load()
  }

  async setAutoAllow(personId: string, on: boolean) {
    const done = await this.run(personId, (c) => c.setAutoAllowBots(personId, on))
    if (done === null) return
    await Promise.all([peopleFor(this.store).load(), this.load()])
  }
}

const models = new WeakMap<BotStore, BotGuestsModel>()

export function botGuestsFor(store: BotStore): BotGuestsModel {
  let model = models.get(store)
  if (!model) models.set(store, (model = new BotGuestsModel(store)))
  return model
}
