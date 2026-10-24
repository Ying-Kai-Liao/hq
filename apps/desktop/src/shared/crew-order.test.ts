import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crewRows } from './crew-order.ts'
import type { Bot } from './models.ts'

const row = (id: string, status: Bot['status'], lastAt: number, pinned = false) => ({ bot: { id, status, lastAt, pinned } as Bot })
const ids = (rows: { bot: Bot }[]) => rows.map((r) => r.bot.id)

const rows = [
  row('old', 'idle', 1),
  row('new', 'idle', 9),
  row('busy', 'working', 5),
  row('ask', 'needsInput', 2),
  row('pin', 'idle', 0, true),
]

test('automatic puts pinned first, then needs you, then working, then recent', () => {
  assert.deepEqual(ids(crewRows(rows, 'automatic')), ['pin', 'ask', 'busy', 'new', 'old'])
})

test('a missing order is automatic', () => {
  assert.deepEqual(ids(crewRows(rows, undefined)), ids(crewRows(rows, 'automatic')))
})

test('manual keeps the drag order', () => {
  assert.deepEqual(ids(crewRows(rows, 'manual')), ['old', 'new', 'busy', 'ask', 'pin'])
})

test('pinned rows keep their drag order in automatic, and an empty roster stays empty', () => {
  const pins = [row('b', 'idle', 1, true), row('a', 'idle', 9, true)]
  assert.deepEqual(ids(crewRows(pins, 'automatic')), ['b', 'a'])
  assert.deepEqual(crewRows([], 'automatic'), [])
})
