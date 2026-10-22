/** Text belongs to a destination, independent of a mounted editor or transcript cache. */
export class ComposerDrafts {
  private values = new Map<string, string>()
  private listeners = new Set<() => void>()
  private retired = false

  private storage: Pick<Storage, 'getItem' | 'setItem'>
  private key: string
  private onSaveError?: () => void

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, onSaveError?: () => void) {
    this.storage = storage
    this.key = key
    this.onSaveError = onSaveError
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? 'null')
      if (Array.isArray(saved)) {
        for (const row of saved) {
          if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string') {
            this.values.set(row[0], row[1])
          }
        }
      }
    } catch { /* A damaged or unavailable store must not prevent typing. */ }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(bot: string, thread: string | null = null) {
    return this.values.get(JSON.stringify([bot, thread])) ?? ''
  }

  set(bot: string, thread: string | null, text: string) {
    if (this.retired) return
    const destination = JSON.stringify([bot, thread])
    if (text) this.values.set(destination, text)
    else this.values.delete(destination)
    this.save()
  }

  removeBot(bot: string) {
    if (this.retired) return
    for (const key of this.values.keys()) {
      try { if (JSON.parse(key)[0] === bot) this.values.delete(key) } catch { this.values.delete(key) }
    }
    this.save()
  }

  clear() {
    if (this.retired) return
    this.values.clear()
    this.save()
  }

  retire() {
    this.retired = true
  }

  private save() {
    // Save on each edit, including clearing after submission; no unmount/debounce race.
    try { this.storage.setItem(this.key, JSON.stringify([...this.values])) } catch { this.onSaveError?.() }
    for (const listener of this.listeners) listener()
  }
}
