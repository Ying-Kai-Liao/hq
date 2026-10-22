/** Sentences grouped into clips of at most `limit` characters (longer sentences are cut). */
export function clips(text: string, limit: number): string[] {
  const out: string[] = []
  let current = ''
  let sentence = ''
  const flush = () => {
    const t = current.trim()
    if (t) out.push(t)
    current = ''
  }
  const add = (piece: string) => {
    if ([...current].length + [...piece].length > limit) flush()
    let rest = [...piece]
    while (rest.length > limit) {
      out.push(rest.slice(0, limit).join(''))
      rest = rest.slice(limit)
    }
    current += rest.join('')
  }
  for (const ch of text) {
    sentence += ch
    if ('.!?。！？\n'.includes(ch)) {
      add(sentence)
      sentence = ''
    }
  }
  add(sentence)
  flush()
  return out
}

/**
 * A reply's clips, fetched one ahead of the one playing. `stop` drops what's queued and any
 * fetch still in flight: a clip that arrives after it is never handed out.
 */
export class ClipQueue<T> {
  private texts: string[] = []
  private ahead: Promise<T | null> | null = null
  private generation = 0

  /** `fetch` resolves null for a clip it couldn't make (and never rejects). */
  private fetch: (text: string) => Promise<T | null>
  constructor(fetch: (text: string) => Promise<T | null>) {
    this.fetch = fetch
  }

  get pending() {
    return this.texts.length > 0 || this.ahead !== null
  }

  add(texts: string[]) {
    this.texts.push(...texts)
  }

  /** The next clip, or null when the queue is empty, a clip failed, or `stop` came meanwhile. */
  async take(): Promise<T | null> {
    const generation = this.generation
    const pending = this.ahead ?? this.fetchNext()
    this.ahead = null
    const clip = await pending
    if (generation !== this.generation || clip === null) return null
    if (this.texts.length) this.ahead = this.fetchNext()
    return clip
  }

  stop() {
    this.generation++
    this.texts = []
    this.ahead = null
  }

  private fetchNext(): Promise<T | null> {
    const text = this.texts.shift()
    if (text === undefined) return Promise.resolve(null)
    return this.fetch(text).catch(() => null)
  }
}
