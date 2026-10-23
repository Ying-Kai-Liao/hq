// An hq agent's memory as files with versions and tidy-ups (`kithMemory*`, serve/docs/bot-info.md). Lenient on
// purpose: a host a little newer or older than the app still draws what it can.
import { toMillis } from './kith-info.ts'

export interface HqMemoryFile { name: string; shared: boolean; path: string; size: number; modified: number | null }
export interface HqMemoryList { agent: HqMemoryFile[]; shared: HqMemoryFile[] }
export interface HqMemoryRead { name: string; shared: boolean; text: string; bytes: number; modified: number | null; truncated: boolean; exists: boolean }

export type HqAuthor = 'kai' | 'agent' | 'tidy' | 'unknown'
export interface HqMemoryVersion {
  id: number
  at: number | null
  author: HqAuthor
  authorBot: string | null
  /** edit · delete · restore · undo · tidy · baseline */
  cause: string
  deleted: boolean
  bytes: number
  lines: number
}
export interface HqSaveResult { version: HqMemoryVersion | null; warnings: string[] }
export interface HqMemoryDiff { from: number | null; to: number | null; diff: string }

export interface HqTidyChange { kind: string; file: string; shared: boolean; text: string; was: string | null }
export interface HqTidyUp {
  id: number
  at: number | null
  undone: boolean
  files: { name: string; shared: boolean; version: number | null }[]
  changes: HqTidyChange[]
}
export interface HqUndoResult { restored: string[]; refused: { file: string; reason: string }[]; undone: boolean }

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const objects = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isObject) : [])

function parseFile(f: Raw, shared: boolean): HqMemoryFile[] {
  const name = str(f.name)
  return name ? [{ name, shared: f.shared === true || shared, path: str(f.path) ?? name, size: num(f.size) ?? 0, modified: toMillis(f.modified) }] : []
}

export function parseMemoryList(raw: unknown): HqMemoryList {
  const r = isObject(raw) ? raw : {}
  return {
    agent: objects(r.agent).flatMap((f) => parseFile(f, false)),
    shared: objects(r.shared).flatMap((f) => parseFile(f, true)),
  }
}

export function parseRead(raw: unknown): HqMemoryRead {
  const r = isObject(raw) ? raw : {}
  const text = str(r.text) ?? ''
  return {
    name: str(r.name) ?? '', shared: r.shared === true, text, bytes: num(r.bytes) ?? text.length,
    modified: toMillis(r.modified), truncated: r.truncated === true, exists: r.exists !== false,
  }
}

/** The wire still says "dream" for a tidy-up on a host from before the rename. */
export function normalizeAuthor(author: unknown): HqAuthor {
  switch (author) {
    case 'kai': return 'kai'
    case 'agent': return 'agent'
    case 'tidy': case 'dream': return 'tidy'
    default: return 'unknown'
  }
}

export function parseVersion(raw: unknown): HqMemoryVersion | null {
  if (!isObject(raw)) return null
  const id = num(raw.id)
  if (id === null) return null
  const cause = str(raw.cause) ?? 'edit'
  return {
    id, at: toMillis(raw.at), author: normalizeAuthor(raw.author), authorBot: str(raw.authorBot),
    cause: cause === 'dream' ? 'tidy' : cause, deleted: raw.deleted === true, bytes: num(raw.bytes) ?? 0, lines: num(raw.lines) ?? 0,
  }
}

export function parseHistory(raw: unknown): HqMemoryVersion[] {
  const r = isObject(raw) ? raw : {}
  return (Array.isArray(r.versions) ? r.versions : []).flatMap((v) => parseVersion(v) ?? [])
}

export function parseSave(raw: unknown): HqSaveResult {
  const r = isObject(raw) ? raw : {}
  const warnings = (Array.isArray(r.warnings) ? r.warnings : []).flatMap((w) => (typeof w === 'string' && w ? [w] : []))
  return { version: parseVersion(r.version), warnings }
}

export function parseDiff(raw: unknown): HqMemoryDiff {
  const r = isObject(raw) ? raw : {}
  return { from: num(r.from), to: num(r.to), diff: str(r.diff) ?? '' }
}

export function parseTidyUps(raw: unknown): HqTidyUp[] {
  const r = isObject(raw) ? raw : {}
  // `dreams` is the answer of a host from before the rename.
  const runs = Array.isArray(r.tidyUps) ? r.tidyUps : Array.isArray(r.dreams) ? r.dreams : []
  return runs.filter(isObject).flatMap((run) => {
    const id = num(run.id)
    if (id === null) return []
    return [{
      id, at: toMillis(run.at), undone: run.undone === true,
      files: objects(run.files).flatMap((f) => (str(f.name) ? [{ name: str(f.name)!, shared: f.shared === true, version: num(f.version) }] : [])),
      changes: objects(run.changes).flatMap((c) => (str(c.file) ? [{
        kind: str(c.kind) ?? 'noted', file: str(c.file)!, shared: c.shared === true, text: str(c.text) ?? '', was: str(c.was),
      }] : [])),
    }]
  })
}

export function parseUndo(raw: unknown): HqUndoResult {
  const r = isObject(raw) ? raw : {}
  return {
    restored: (Array.isArray(r.restored) ? r.restored : []).flatMap((x) => (typeof x === 'string' ? [x] : [])),
    refused: objects(r.refused).flatMap((x) => (str(x.file) ? [{ file: str(x.file)!, reason: str(x.reason) ?? '' }] : [])),
    undone: r.undone === true,
  }
}

/** Who made a version, for its row; `botName` names the agent. */
export function authorText(v: Pick<HqMemoryVersion, 'author' | 'authorBot'>, botName: (id: string | null) => string): string {
  switch (v.author) {
    case 'kai': return 'You'
    case 'agent': return v.authorBot ? botName(v.authorBot) : 'The agent'
    case 'tidy': return 'Tidy-up'
    default: return 'Outside edit'
  }
}

/** What a version did, for its row. */
export function causeText(cause: string): string {
  switch (cause) {
    case 'baseline': return 'First version kept'
    case 'delete': return 'Deleted'
    case 'restore': return 'Brought back an earlier version'
    case 'undo': return 'Undid a tidy-up'
    case 'tidy': case 'dream': return 'Tidied'
    default: return 'Changed'
  }
}

/** The version a diff for `versions[index]` compares with: the next older one; null for the oldest (the baseline). */
export function previousVersion(versions: HqMemoryVersion[], index: number): HqMemoryVersion | null {
  return versions[index + 1] ?? null
}

/** Whether the file changed after it was opened: the newest version is not the one seen then. */
export function movedSince(openedNewest: number | null, nowNewest: number | null): boolean {
  return openedNewest !== nowNewest
}

export type DiffKind = 'add' | 'del' | 'gap' | 'ctx'
/** `- `/`+ ` lines, `  ` context, `…` gaps. */
export function diffLines(diff: string): { kind: DiffKind; text: string }[] {
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => {
    if (line.startsWith('+ ')) return { kind: 'add' as const, text: line.slice(2) }
    if (line.startsWith('- ')) return { kind: 'del' as const, text: line.slice(2) }
    if (line.startsWith('…')) return { kind: 'gap' as const, text: line }
    return { kind: 'ctx' as const, text: line.startsWith('  ') ? line.slice(2) : line }
  })
}

const CHANGE_KIND: Record<string, string> = {
  added: 'Added', archived: 'Archived', reviewed: 'Reviewed', noted: 'Noted', indexed: 'Indexed',
}

/** One change of a tidy-up as a line. A reviewed line shows what it was. */
export function changeText(c: HqTidyChange): string {
  const where = `${c.shared ? 'shared/' : ''}${c.file}`
  return `${CHANGE_KIND[c.kind] ?? 'Changed'} in ${where}: ${c.text}${c.kind === 'reviewed' && c.was ? ` (was: ${c.was})` : ''}`
}

/** The index file first (MEMORY.md, user.md), then the newest. */
export function fileOrder(files: HqMemoryFile[]): HqMemoryFile[] {
  const isIndex = (f: HqMemoryFile) => f.name === 'MEMORY.md' || f.name === 'user.md'
  return [...files].sort((a, b) => Number(isIndex(b)) - Number(isIndex(a)) || (b.modified ?? 0) - (a.modified ?? 0))
}
