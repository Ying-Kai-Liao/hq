/** Unsent text belongs to a conversation, independently of its mounted composer. */
export class ComposerDrafts {
  private bots = new Map<string, Map<string | null, string>>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(botId: string, thread: string | null = null): string {
    return this.bots.get(botId)?.get(thread) ?? ''
  }

  set(botId: string, thread: string | null, text: string) {
    if (this.get(botId, thread) === text) return
    const threads = this.bots.get(botId) ?? new Map<string | null, string>()
    if (text) {
      threads.set(thread, text)
      this.bots.set(botId, threads)
    } else {
      threads.delete(thread)
      if (!threads.size) this.bots.delete(botId)
    }
    this.changed()
  }

  /** Transfer a draft to a send; asynchronous delivery never owns the next draft. */
  take(botId: string, thread: string | null, hasFiles = false): string | null {
    const text = this.get(botId, thread)
    if (!text.trim() && !hasFiles) return null
    this.set(botId, thread, '')
    return text
  }

  deleteBot(botId: string) {
    if (this.bots.delete(botId)) this.changed()
  }

  clear() {
    if (!this.bots.size) return
    this.bots.clear()
    this.changed()
  }

  private changed() {
    for (const listener of [...this.listeners]) listener()
  }
}
