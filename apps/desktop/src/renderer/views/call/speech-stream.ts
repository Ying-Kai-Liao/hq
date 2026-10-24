import { spokenText } from './spoken-text.ts'

// Pure parts of Kith voice's live speech: which sentences of a growing reply are ready to say,
// whether a transcript is the bot's own voice coming back through the microphone, and when to say
// "working on it".

const CJK_TERMINATORS = '。！？\n'
const ASCII_TERMINATORS = '.!?'

/** True when a sentence ends after `text[i]`. A '.' inside "3.5" or "a.ts" doesn't end one. */
function endsAt(text: string, i: number): boolean {
  const ch = text[i]!
  if (CJK_TERMINATORS.includes(ch)) return true
  if (!ASCII_TERMINATORS.includes(ch)) return false
  const next = text[i + 1]
  return next !== undefined && /\s/.test(next)
}

/** Where the last finished sentence of `text` ends (an index), or 0. */
export function sentenceEnd(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) if (endsAt(text, i)) return i + 1
  return 0
}

/** The first sentence end at or after `from`, or the text's end. */
function sentenceEndFrom(text: string, from: number): number {
  for (let i = Math.max(from - 1, 0); i < text.length; i++) if (endsAt(text, i)) return i + 1
  return text.length
}

/** The reply as it sounds so far: an unclosed code block is cut, so code isn't read out while it streams in. */
function cleaned(markdown: string, final: boolean): string {
  let text = markdown
  let cut = false
  if (!final) {
    const fences = text.match(/```/g)?.length ?? 0
    if (fences % 2 === 1) {
      text = text.slice(0, text.lastIndexOf('```'))
      cut = true
    }
  }
  // Trailing spaces would make the text before a code block differ from itself once the block closes.
  // The cut itself is a sentence end.
  return spokenText(text).replace(/[ \t]+\n/g, '\n') + (cut ? '\n' : '')
}

interface Progress {
  /** The cleaned text already handed out. */
  spoken: string
  /** An update rewrote text that was already spoken: nothing more until the entry is final. */
  rewritten: boolean
  final: boolean
  /** The user cut this reply short. */
  muted: boolean
}

/**
 * Turns the full, growing text of each agent entry (the host sends the whole buffer about every
 * 300 ms) into the sentences not yet spoken, once each and in order.
 */
export class SentenceStream {
  private entries = new Map<string, Progress>()

  /** The text newly ready to be spoken for this entry ('' when nothing). */
  feed(id: string, markdown: string, final: boolean): string {
    let p = this.entries.get(id)
    if (!p) this.entries.set(id, (p = { spoken: '', rewritten: false, final: false, muted: false }))
    if (p.final) return ''
    p.final = final
    if (p.muted) return ''
    const text = cleaned(markdown, final)
    if (!text.startsWith(p.spoken)) {
      if (!p.rewritten) console.warn('kith voice: a reply changed after it was spoken; the rest waits for its end')
      p.rewritten = true
    }
    if (p.rewritten) {
      if (!final) return ''
      // Conservative: skip to the next sentence after the length already spoken, so nothing is said twice.
      const from = sentenceEndFrom(text, p.spoken.length)
      p.spoken = text
      return text.slice(from).trim()
    }
    const end = final ? text.length : sentenceEnd(text)
    if (end <= p.spoken.length) return ''
    const chunk = text.slice(p.spoken.length, end)
    p.spoken = text.slice(0, end)
    return chunk.trim()
  }

  /** Nothing more of the replies still streaming is spoken (the user talked over or tapped). */
  muteOpen() {
    for (const p of this.entries.values()) if (!p.final) p.muted = true
  }

  /** Some reply is still streaming in, so more speech may come. */
  get open() {
    for (const p of this.entries.values()) if (!p.final && !p.muted) return true
    return false
  }
}

// MARK: echo

const TOKEN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[\p{L}\p{N}]+/gu

interface Token {
  word: string
  end: number
}

function tokens(text: string): Token[] {
  return [...text.toLowerCase().matchAll(TOKEN)].map((m) => ({ word: m[0], end: m.index + m[0].length }))
}

const isCjk = (w: string) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(w)

/** Words in a transcript; a Chinese or Japanese character counts half. */
export function wordCount(text: string): number {
  return tokens(text).reduce((n, t) => n + (isCjk(t.word) ? 0.5 : 1), 0)
}

const bigrams = (words: string[]) => new Set(words.slice(1).map((w, i) => `${words[i]} ${w}`))

/**
 * The transcript is (mostly) the text being spoken: the share of its words that sit in a word
 * pair also found in `spoken` is at least 70%. Single words match too easily ("that is right").
 */
export function isEcho(heard: string, spoken: string): boolean {
  const words = tokens(heard).map((t) => t.word)
  if (words.length === 0) return true
  if (words.length === 1) return tokens(spoken).some((t) => t.word === words[0])
  const known = bigrams(tokens(spoken).map((t) => t.word))
  const covered = new Array<boolean>(words.length).fill(false)
  for (let i = 1; i < words.length; i++) {
    if (known.has(`${words[i - 1]} ${words[i]}`)) covered[i - 1] = covered[i] = true
  }
  return covered.filter(Boolean).length / words.length >= 0.7
}

/** How much of the bot's recent speech is kept to compare against. */
export const ECHO_WINDOW_CHARS = 800

/** `recent` with `said` added, keeping only the last `ECHO_WINDOW_CHARS` characters. */
export function rememberSpoken(recent: string, said: string): string {
  return `${recent} ${said}`.slice(-ECHO_WINDOW_CHARS)
}

/** A run of at least this many words copied from the spoken text counts as the bot's voice. */
const MIN_ECHO_RUN = 3

/**
 * The transcript without its start if that start is the spoken text coming back: the recognizer
 * keeps one running transcript, so the user's words arrive after the bot's.
 */
export function stripEcho(heard: string, spoken: string): string {
  if (!spoken) return heard
  const said = tokens(heard)
  const reference = ` ${tokens(spoken).map((t) => t.word).join(' ')} `
  for (let n = said.length; n >= MIN_ECHO_RUN; n--) {
    if (reference.includes(` ${said.slice(0, n).map((t) => t.word).join(' ')} `)) return heard.slice(said[n - 1]!.end).replace(/^[^\p{L}\p{N}]+/u, '').trimEnd()
  }
  return heard
}

// MARK: cue

export const CUE_AFTER_MS = 5000

/**
 * Whether to say "Working on it": the bot is still working, nothing has been spoken since the
 * user's message, and it has been quiet for a while. Once per message.
 */
export function shouldCue(s: { now: number; sentAt: number | null; lastSpokenAt: number; working: boolean; cued: boolean; after?: number }): boolean {
  if (s.sentAt === null || s.cued || !s.working) return false
  if (s.lastSpokenAt >= s.sentAt) return false
  return s.now - s.sentAt >= (s.after ?? CUE_AFTER_MS)
}
