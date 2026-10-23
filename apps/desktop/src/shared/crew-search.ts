// The sidebar box's search: letters turn the list into results in place, in labelled sections. Pure, so node --test
// covers it. Only what the app has today is searched: agents, groups and task threads (people and the crew's memory
// have no desktop backend yet).

export interface CrewRef {
  computerId: string
  botId: string
}

export interface CrewSearchSource {
  ref: CrewRef
  name: string
  description: string
  lastMessage: string
  isGroup: boolean
  /** The room's task threads: id, title and last activity. */
  threads: { id: string; title: string; at: number }[]
}

export interface CrewHit {
  key: string
  ref: CrewRef
  /** The room's name; for a thread, the thread's title. */
  title: string
  /** For a thread, the room it is in. */
  room: string
  kind: 'agent' | 'group' | 'thread'
}

export interface CrewResults {
  agents: CrewHit[]
  groups: CrewHit[]
  threads: CrewHit[]
}

/** 0 best: name starts with the query, a word of it does, it contains it; 3 only a secondary text does; -1 no match. */
export function matchRank(query: string, name: string, ...others: string[]): number {
  const q = query.trim().toLowerCase()
  if (!q) return -1
  const n = name.toLowerCase()
  if (n.startsWith(q)) return 0
  if (n.split(/[\s\-_·]+/).some((w) => w.startsWith(q))) return 1
  if (n.includes(q)) return 2
  return others.some((o) => o.toLowerCase().includes(q)) ? 3 : -1
}

const ranked = (hits: { hit: CrewHit; rank: number }[]) => hits.sort((a, b) => a.rank - b.rank).map((h) => h.hit)

/** Agents, groups and threads matching `query`, each section best match first (ties keep the sidebar's order). */
export function searchCrew(sources: CrewSearchSource[], query: string): CrewResults {
  const agents: { hit: CrewHit; rank: number }[] = []
  const groups: { hit: CrewHit; rank: number }[] = []
  const threads: { hit: CrewHit; rank: number }[] = []
  for (const s of sources) {
    const key = `${s.ref.computerId}/${s.ref.botId}`
    const rank = matchRank(query, s.name, s.description, s.lastMessage)
    if (rank >= 0) (s.isGroup ? groups : agents).push({ rank, hit: { key, ref: s.ref, title: s.name, room: s.name, kind: s.isGroup ? 'group' : 'agent' } })
    for (const t of [...s.threads].sort((a, b) => b.at - a.at)) {
      const r = matchRank(query, t.title)
      if (r >= 0) threads.push({ rank: r, hit: { key: `${key}/${t.id}`, ref: s.ref, title: t.title, room: s.name, kind: 'thread' } })
    }
  }
  return { agents: ranked(agents), groups: ranked(groups), threads: ranked(threads) }
}

/** What Return opens and ⌘1…9 count through: the sections in the order they show. */
export const resultList = (r: CrewResults): CrewHit[] => [...r.agents, ...r.groups, ...r.threads]

/** A text split for the soft yellow highlight: every occurrence of the query is a hit. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let from = 0
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, from)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false })
    out.push({ text: text.slice(at, at + q.length), hit: true })
    from = at + q.length
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false })
  return out.length ? out : [{ text, hit: false }]
}
