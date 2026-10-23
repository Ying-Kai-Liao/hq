/** One line of the call screen's live transcript. */
export interface CaptionLine {
  id: number
  who: 'you' | 'bot'
  text: string
  /** Still being said (you) or still arriving (bot); the screen draws it a little fainter. */
  live: boolean
}

/** Lines kept: a call screen shows the recent exchange, not the whole call. */
export const MAX_CAPTIONS = 24

/**
 * What the call screen shows as text: what you are saying right now (replaced as the recognizer
 * revises it, then fixed when it is sent) and the sentences the bot speaks (joined while one turn
 * of speech goes on). Pure so it can be tested; engines own one and call `changed()` after.
 */
export class Captions {
  lines: CaptionLine[] = []
  private nextId = 1

  /** The words heard so far of the current utterance; empty drops the line. */
  hearing(text: string) {
    const clean = text.trim()
    const last = this.lines[this.lines.length - 1]
    if (last?.who === 'you' && last.live) {
      if (clean) this.lines = [...this.lines.slice(0, -1), { ...last, text: clean }]
      else this.lines = this.lines.slice(0, -1)
    } else if (clean) {
      this.push({ who: 'you', text: clean, live: true })
    }
  }

  /** The utterance was sent (or abandoned): its line stops being live. */
  settleYou() {
    const last = this.lines[this.lines.length - 1]
    if (last?.who === 'you' && last.live) this.lines = [...this.lines.slice(0, -1), { ...last, live: false }]
  }

  /** A sentence the bot is saying. Consecutive ones read as one paragraph. */
  said(text: string) {
    const clean = text.trim()
    if (!clean) return
    this.settleYou()
    const last = this.lines[this.lines.length - 1]
    if (last?.who === 'bot') this.lines = [...this.lines.slice(0, -1), { ...last, text: `${last.text} ${clean}`, live: true }]
    else this.push({ who: 'bot', text: clean, live: true })
  }

  /** The bot stopped talking (finished or cut short). */
  settleBot() {
    const last = this.lines[this.lines.length - 1]
    if (last?.who === 'bot' && last.live) this.lines = [...this.lines.slice(0, -1), { ...last, live: false }]
  }

  private push(line: Omit<CaptionLine, 'id'>) {
    this.lines = [...this.lines, { ...line, id: this.nextId++ }].slice(-MAX_CAPTIONS)
  }
}
