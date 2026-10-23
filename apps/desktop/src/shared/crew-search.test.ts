import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlight, matchRank, resultList, searchCrew, type CrewSearchSource } from './crew-search.ts'

const src = (id: string, name: string, extra: Partial<CrewSearchSource> = {}): CrewSearchSource => ({
  ref: { computerId: 'mac', botId: id },
  name,
  description: '',
  lastMessage: '',
  isGroup: false,
  threads: [],
  ...extra,
})

test('a name match beats a word match, a substring and the status line', () => {
  assert.deepEqual([matchRank('sw', 'swap'), matchRank('sw', 'the swap'), matchRank('wa', 'swap'), matchRank('swap', 'coder', 'swap high')], [0, 1, 2, 3])
  assert.equal(matchRank('zz', 'swap'), -1)
  assert.equal(matchRank('  ', 'swap'), -1)
})

test('results come in Agents, Groups, Threads, best first', () => {
  const r = searchCrew(
    [
      src('a', 'coder', { threads: [{ id: 't', title: 'Why is swap high', at: 2 }, { id: 'u', title: 'Swap alert', at: 1 }] }),
      src('b', 'resource-manager', { lastMessage: 'Watching swap 2.1 GB' }),
      src('g', 'Swap team', { isGroup: true }),
    ],
    'swap',
  )
  assert.deepEqual(r.agents.map((h) => h.title), ['resource-manager'])
  assert.deepEqual(r.groups.map((h) => h.title), ['Swap team'])
  assert.deepEqual(r.threads.map((h) => h.title), ['Swap alert', 'Why is swap high'])
  assert.equal(r.threads[0]!.room, 'coder')
  assert.equal(resultList(r)[0]!.kind, 'agent')
})

test('the highlight marks every occurrence, ignoring case', () => {
  assert.deepEqual(highlight('Swap alert: swap', 'swap'), [
    { text: 'Swap', hit: true },
    { text: ' alert: ', hit: false },
    { text: 'swap', hit: true },
  ])
  assert.deepEqual(highlight('plain', ''), [{ text: 'plain', hit: false }])
})
