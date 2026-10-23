import type { Entry } from './models.ts'
import { isChat } from './models.ts'

/** Tool calls in a row beyond this many fold into "N earlier steps" (a long task can run hundreds). Same as iOS. */
export const VISIBLE_STEPS = 4

/** What an open thread shows under its first message, in order. */
export type ThreadReply =
  | { kind: 'entry'; id: string; entry: Entry; groupStart: boolean }
  | { kind: 'tool'; id: string; entry: Entry }
  | { kind: 'earlier'; id: string; count: number }

/** Your own message keeps its `user-<nonce>` id when the host confirms it, so the row doesn't redraw. */
const stableId = (e: Entry) => (e.kind === 'user' && e.data.clientNonce ? `user-${e.data.clientNonce}` : e.id)

/** Chat-visible replies and tool calls; a run of tool calls longer than `VISIBLE_STEPS` keeps its newest ones. */
export function threadFeed(entries: Entry[]): ThreadReply[] {
  const out: ThreadReply[] = []
  let run: Entry[] = []
  let lastAuthor: string | null = null
  const flush = () => {
    if (run.length > VISIBLE_STEPS) out.push({ kind: 'earlier', id: `earlier-${run[0]!.id}`, count: run.length - VISIBLE_STEPS })
    for (const e of run.slice(-VISIBLE_STEPS)) out.push({ kind: 'tool', id: e.id, entry: e })
    run = []
  }
  for (const e of entries) {
    if (e.kind === 'tool') {
      run.push(e)
      continue
    }
    if (!isChat(e)) continue
    flush()
    const author = e.kind === 'user' ? 'user' : e.kind === 'agent' ? `agent:${e.data.author ?? ''}` : e.kind
    out.push({ kind: 'entry', id: stableId(e), entry: e, groupStart: author !== lastAuthor })
    lastAuthor = author === 'user' || e.kind === 'agent' ? author : null
  }
  flush()
  return out
}

const VERBS: Record<string, string> = {
  read: 'Read', edit: 'Edited', delete: 'Deleted', move: 'Moved', search: 'Searched', execute: 'Ran', think: 'Thought', fetch: 'Fetched',
}

export interface ToolRowModel {
  verb: string
  object: string
  result?: string
  state: 'running' | 'done' | 'error'
  command?: string
  output?: string
}

/** One tool entry as one row: "Edited kith-sessions.py  +6 -2". */
export function toolRowOf(entry: Entry): ToolRowModel {
  const d = entry.data
  const diffs = d.diffs ?? []
  const first = diffs[0]
  const object = first
    ? `${first.path.split('/').pop()}${diffs.length > 1 ? ` +${diffs.length - 1}` : ''}`
    : (d.title ?? '').split('\n')[0] ?? ''
  const added = diffs.reduce((n, x) => n + x.added, 0)
  const removed = diffs.reduce((n, x) => n + x.removed, 0)
  const state = d.status === 'completed' ? 'done' : d.status === 'failed' ? 'error' : 'running'
  const result = state === 'done' ? (diffs.length ? `+${added} -${removed}` : 'done') : state === 'error' ? 'failed' : undefined
  const command = d.command || (d.toolKind === 'execute' ? d.title : undefined) || undefined
  const patches = diffs.map((x) => x.patch).join('\n')
  const output = [d.output, patches].filter(Boolean).join('\n\n') || undefined
  return { verb: VERBS[d.toolKind ?? ''] ?? 'Used', object, result, state, command, output }
}
