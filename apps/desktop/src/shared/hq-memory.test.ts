import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authorText, causeText, changeText, diffLines, fileOrder, movedSince, normalizeAuthor, parseHistory, parseMemoryList,
  parseRead, parseSave, parseTidyUps, parseUndo, previousVersion,
} from './hq-memory.ts'

test('list keeps both layers and drops nameless files', () => {
  const list = parseMemoryList({ agent: [{ name: 'MEMORY.md', shared: false, path: '/a/MEMORY.md', size: 12, modified: 1_700_000_000 }, { size: 1 }], shared: [{ name: 'user.md', shared: true, path: '/u.md', size: 3, modified: 0 }] })
  assert.equal(list.agent.length, 1)
  assert.equal(list.agent[0].modified, 1_700_000_000_000)
  assert.equal(list.shared[0].shared, true)
  assert.deepEqual(parseMemoryList(null), { agent: [], shared: [] })
})

test('read of a file not made yet is empty and does not exist', () => {
  const r = parseRead({ name: 'a.md', shared: false, text: '', bytes: 0, modified: 0, exists: false })
  assert.equal(r.exists, false)
  assert.equal(parseRead({ name: 'a.md', text: 'x', truncated: true }).truncated, true)
  assert.equal(parseRead({ name: 'a.md', text: 'x' }).exists, true)
})

test('an old dream author and cause read as tidy', () => {
  assert.equal(normalizeAuthor('dream'), 'tidy')
  assert.equal(normalizeAuthor('mystery'), 'unknown')
  const [v] = parseHistory({ versions: [{ id: 4, at: 1_700_000_000, author: 'dream', authorBot: null, cause: 'dream', deleted: false, bytes: 3, lines: 1 }] })
  assert.equal(v.author, 'tidy')
  assert.equal(v.cause, 'tidy')
  assert.equal(authorText(v, () => 'x'), 'Tidy-up')
  assert.equal(causeText('dream'), 'Tidied')
})

test('author names the agent and the user', () => {
  assert.equal(authorText({ author: 'kai', authorBot: null }, () => 'x'), 'You')
  assert.equal(authorText({ author: 'agent', authorBot: 'b1' }, (id) => `bot ${id}`), 'bot b1')
  assert.equal(authorText({ author: 'unknown', authorBot: null }, () => 'x'), 'Outside edit')
})

test('save returns warnings and a null version when nothing changed', () => {
  const r = parseSave({ version: null, warnings: ['big drop', 3, ''] })
  assert.equal(r.version, null)
  assert.deepEqual(r.warnings, ['big drop'])
  assert.equal(parseSave({ version: { id: 9 }, warnings: [] }).version?.id, 9)
})

test('tidy-ups parse from the new name and the pre-rename one', () => {
  const run = { id: 2, at: 1_700_000_000, undone: false, files: [{ name: 'MEMORY.md', shared: false, version: 5 }], changes: [{ kind: 'reviewed', file: 'MEMORY.md', shared: false, text: 'new', was: 'old' }] }
  assert.equal(parseTidyUps({ tidyUps: [run] })[0].changes[0].was, 'old')
  assert.equal(parseTidyUps({ dreams: [run] }).length, 1)
  assert.deepEqual(parseTidyUps({}), [])
  assert.equal(changeText(parseTidyUps({ tidyUps: [run] })[0].changes[0]), 'Reviewed in MEMORY.md: new (was: old)')
})

test('undo keeps the refused reasons', () => {
  const u = parseUndo({ restored: ['MEMORY.md'], refused: [{ file: 'a.md', reason: 'changed since' }], undone: false })
  assert.deepEqual(u.refused, [{ file: 'a.md', reason: 'changed since' }])
  assert.equal(u.undone, false)
})

test('a version is compared with the next older one; the oldest has none', () => {
  const versions = parseHistory({ versions: [{ id: 3 }, { id: 2 }, { id: 1 }] })
  assert.equal(previousVersion(versions, 0)?.id, 2)
  assert.equal(previousVersion(versions, 2), null)
})

test('moved since open', () => {
  assert.equal(movedSince(3, 3), false)
  assert.equal(movedSince(3, 4), true)
  assert.equal(movedSince(null, 1), true)
  assert.equal(movedSince(null, null), false)
})

test('diff lines', () => {
  assert.deepEqual(diffLines('  keep\n- old\n+ new\n…\n'), [
    { kind: 'ctx', text: 'keep' }, { kind: 'del', text: 'old' }, { kind: 'add', text: 'new' }, { kind: 'gap', text: '…' },
  ])
})

test('files: the index first, then newest', () => {
  const f = (name: string, modified: number) => ({ name, shared: false, path: name, size: 1, modified })
  assert.deepEqual(fileOrder([f('a.md', 5), f('MEMORY.md', 1), f('b.md', 9)]).map((x) => x.name), ['MEMORY.md', 'b.md', 'a.md'])
})
