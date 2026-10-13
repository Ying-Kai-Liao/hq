import {
  FINISHED_MS, isActive, islandFrame, islandMode, islandRect, justFinished,
  type IslandBot, type IslandPermission, type IslandScreen, type IslandSummary,
} from '@shared/island'
import { Observable } from '../../lib/observable'

const LIST_LIMIT = 6
/** Opened without the pointer on it (a click through accessibility): folds by itself after this. */
const UNATTENDED_MS = 8000

/** The island window's state: the chat window's summary, the pointer, and approvals put off. */
export class IslandModel extends Observable {
  summary: IslandSummary = { bots: [], permissions: [] }
  screen: IslandScreen = { notch: null }
  open = false
  finished: IslandBot | null = null
  /** The shape grew on its last change: open with a spring, close without one. */
  growing = true
  private hovering = false
  private deferred = new Set<string>()
  private content = 0
  private statuses: Map<string, string> | null = null
  private hoverTimer: ReturnType<typeof setTimeout> | undefined
  private finishTimer: ReturnType<typeof setTimeout> | undefined
  private shape = { width: 0, height: 0 }

  start() {
    const island = window.codync.island
    island.onSummary((s) => this.apply(s))
    island.onScreen((s) => this.update(() => (this.screen = s)))
    island.onHover((inside) => this.hover(inside))
    // Linux shapes the window to the island (main/island.ts): the pointer entering the window is the hover.
    if (window.codync.platform === 'linux') {
      document.documentElement.addEventListener('mouseenter', () => this.hover(true))
      document.documentElement.addEventListener('mouseleave', () => this.hover(false))
    }
    void island.state().then(({ screen, summary }) => {
      this.screen = screen
      this.apply(summary)
    })
  }

  get mode() {
    return islandMode(this.summary, { open: this.open, deferred: this.deferred, finished: this.finished !== null })
  }

  get frame() {
    return islandFrame(this.mode, this.screen, this.content)
  }

  /** The approval to answer now: the first not put off, else the first. */
  get permission(): IslandPermission | null {
    const cards = this.summary.permissions
    return cards.find((p) => !this.deferred.has(p.entryId)) ?? cards[0] ?? null
  }

  /** The compact island's bot: one that needs you, else one working. */
  get focus() {
    const bots = this.summary.bots
    return bots.find((b) => b.status === 'needsInput') ?? bots.find(isActive) ?? null
  }

  get activeCount() {
    return this.summary.bots.filter(isActive).length
  }

  /** The open list: bots that work or wait first, then the rest in roster order. */
  get bots() {
    const bots = this.summary.bots
    return [...bots.filter(isActive), ...bots.filter((b) => !isActive(b))].slice(0, LIST_LIMIT)
  }

  setContentHeight(height: number) {
    if (height !== this.content) this.update(() => (this.content = height))
  }

  /** A click on the closed island opens it at once. */
  openNow() {
    clearTimeout(this.hoverTimer)
    if (!this.hovering) this.hoverTimer = setTimeout(() => this.update(() => (this.open = false)), UNATTENDED_MS)
    this.update(() => (this.open = true))
  }

  /** Folds the approval away until the island is opened again or another one arrives. */
  later(card: IslandPermission) {
    this.update(() => {
      this.deferred.add(card.entryId)
      this.open = false
    })
  }

  /** Answers the card and folds the island: the bot carries on. */
  respond(card: IslandPermission, optionId: string) {
    window.codync.island.respond(card.ref, card.entryId, optionId)
    this.update(() => (this.open = false))
  }

  openBot(ref: string) {
    window.codync.island.openBot(ref)
    clearTimeout(this.finishTimer)
    this.update(() => {
      this.open = false
      this.finished = null
    })
  }

  private apply(summary: IslandSummary) {
    const done = this.statuses ? justFinished(this.statuses, summary.bots) : []
    this.statuses = new Map(summary.bots.map((b) => [b.ref, b.status]))
    this.update(() => {
      this.summary = summary
      // Answered and expired cards leave the put-off set.
      for (const id of this.deferred) if (!summary.permissions.some((p) => p.entryId === id)) this.deferred.delete(id)
      if (done[0]) this.showFinished(done[0])
    })
  }

  private showFinished(bot: IslandBot) {
    clearTimeout(this.finishTimer)
    this.finished = bot
    this.finishTimer = setTimeout(() => this.update(() => (this.finished = null)), FINISHED_MS)
  }

  /** Opens after a short rest on the island (longer over the bare notch), folds soon after the pointer leaves. */
  private hover(inside: boolean) {
    this.hovering = inside
    clearTimeout(this.hoverTimer)
    const delay = inside ? (this.mode === 'hidden' ? 600 : 250) : 500
    this.hoverTimer = setTimeout(() => this.update(() => (this.open = inside)), delay)
  }

  private update(change: () => void) {
    change()
    const frame = this.frame
    if (frame.width !== this.shape.width || frame.height !== this.shape.height) {
      this.growing = frame.width * frame.height >= this.shape.width * this.shape.height
      this.shape = { width: frame.width, height: frame.height }
      window.codync.island.setShape(islandRect(frame, window.innerWidth))
    }
    this.changed()
  }
}
