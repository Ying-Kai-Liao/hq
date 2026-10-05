import { isChat, type Entry } from '@shared/models'

export type ChatItem =
  | { id: string; kind: 'separator'; date: number }
  | { id: string; kind: 'entry'; entry: Entry; groupStart: boolean }

/**
 * Chat-visible entries plus time separators (gaps > 1 h) and author grouping. `streaming`: a
 * turn is running in this chat, so the text being generated right now (the lane's last entry,
 * still `final == false`) shows in place and never pops in later.
 */
export function buildChat(entries: Entry[], streaming = false, steady = false): ChatItem[] {
  const out: ChatItem[] = []
  const used = new Set<string>()
  let lastDate: number | null = null
  let lastAuthor: string | null = null
  const lastEntry = entries[entries.length - 1]
  const live = !streaming ? null : steady ? liveText(entries) : lastEntry && lastEntry.kind === 'agent' && lastEntry.data.final === false ? lastEntry.id : null
  for (const e of entries) {
    if (!(isChat(e) || (e.id === live && e.data.text && e.data.text !== '(pass)'))) continue
    let id = e.kind === 'user' && e.data.clientNonce ? `user-${e.data.clientNonce}` : e.id
    // `steady`: a reply is one item per author and turn, from its first words to the final
    // message, so its bubble never pops out and back in.
    const reply = `reply-${e.data.author ?? ''}-${e.turn}`
    if (steady && e.kind === 'agent' && !used.has(reply)) id = reply
    used.add(id)
    if (lastDate === null || e.createdAt - lastDate > 3_600_000) {
      out.push({ id: `sep-${id}`, kind: 'separator', date: e.createdAt })
      lastAuthor = null
    }
    // In a group each bot is its own author.
    const author = e.kind === 'user' ? 'user' : e.kind === 'agent' ? `agent:${e.data.author ?? ''}` : e.kind
    out.push({ id, kind: 'entry', entry: e, groupStart: author !== lastAuthor })
    lastAuthor = author === 'user' || e.kind === 'agent' ? author : null
    lastDate = e.createdAt
  }
  return out
}

/** The running turn's newest text, if any since the last message or final reply. */
function liveText(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'user' || (e.kind === 'agent' && e.data.final === true)) return null
    if (e.kind === 'agent' && e.data.text) return e.data.text === '(pass)' ? null : e.id
  }
  return null
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export const relativeTime = {
  time: (ms: number) => time.format(new Date(ms)),
  /** Chat separator: Today 3:27 AM · Yesterday 5:20 PM · Sep 16 9:02 AM */
  separator(ms: number) {
    const date = new Date(ms)
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000)
    const day = sameDay(date, now) ? 'Today' : sameDay(date, yesterday) ? 'Yesterday' : monthDay.format(date)
    return `${day} ${time.format(date)}`
  },
  /** Roster stamp: 3:45 AM · Yesterday · Wednesday · Sep 16 */
  day(ms: number) {
    const date = new Date(ms)
    const now = new Date()
    if (sameDay(date, now)) return time.format(date)
    if (sameDay(date, new Date(now.getTime() - 86_400_000))) return 'Yesterday'
    if (now.getTime() - ms < 6 * 86_400_000) return weekday.format(date)
    return monthDay.format(date)
  },
  /** Grok-style compact age: now · 5m · 3h · 2d · Sep 3 */
  short(ms: number) {
    const s = Math.max(0, (Date.now() - ms) / 1000)
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86_400) return `${Math.floor(s / 3600)}h`
    if (s < 86_400 * 7) return `${Math.floor(s / 86_400)}d`
    return monthDay.format(new Date(ms))
  },
}
