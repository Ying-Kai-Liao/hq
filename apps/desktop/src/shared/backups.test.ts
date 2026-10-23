import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addable, backAt, hasClaudeAccount, isOut, loginCommand, move, parseBackups, stateText, viaLabel, entryFor,
} from './backups.ts'

const sample = {
  global: ['codex', 'claude:work'],
  agents: { house: ['claude:work'] },
  entries: [
    { id: 'codex', harness: 'codex', account: null, kind: 'subscription', ready: false, why: 'not logged in', fix: 'codex login', outUntil: null, reason: null },
    { id: 'claude:work', harness: 'claude', account: 'work', kind: 'subscription', ready: true, why: null, fix: null, outUntil: 2_000_000, reason: 'rate_limit' },
    { id: 'codex:deep', harness: 'codex', account: 'deep', kind: 'subscription', ready: true },
    { bad: true },
  ],
}

test('the host answer parses and leaves out what it cannot read', () => {
  const b = parseBackups(sample)
  assert.deepEqual(b.global, ['codex', 'claude:work'])
  assert.deepEqual(b.agents, { house: ['claude:work'] })
  assert.equal(b.entries.length, 3)
  assert.equal(b.entries[1]!.outUntil, 2_000_000)
  assert.equal(b.entries[2]!.why, null)
})

test('garbage reads as an empty chain', () => {
  for (const raw of [null, 'x', [], {}, { global: 5, entries: 'no' }]) {
    const b = parseBackups(raw)
    assert.deepEqual([b.global, b.agents, b.entries], [[], {}, []])
  }
})

test('the badge says which entry answered, and nothing for the primary or old messages', () => {
  assert.equal(viaLabel('codex'), 'via codex')
  assert.equal(viaLabel('claude:work'), 'via claude:work')
  for (const none of [null, undefined, '', 5]) assert.equal(viaLabel(none), null)
})

test('state: ready, out until a time, or blocked with a reason', () => {
  const b = parseBackups(sample)
  const now = 1_000_000
  assert.equal(stateText(b.entries[1]!, now).tone, 'out')
  assert.match(stateText(b.entries[1]!, now).text, /^out of usage, back at /)
  assert.deepEqual(stateText(b.entries[0]!, now), { text: 'not logged in', tone: 'blocked' })
  assert.deepEqual(stateText(b.entries[2]!, now), { text: 'ready', tone: 'ok' })
  assert.equal(isOut(b.entries[1]!, 3_000_000), false, 'back once the time has passed')
  assert.match(backAt(now + 60_000, now), /^back at /)
})

test('an entry out with no reset time still reads as out only when the host sent a time', () => {
  const e = { ...parseBackups(sample).entries[2]!, outUntil: null, reason: 'rate_limit' }
  assert.equal(isOut(e), false)
})

test('move reorders and ignores a place that is not there', () => {
  assert.deepEqual(move(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  assert.deepEqual(move(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c'])
  assert.deepEqual(move(['a', 'b'], 0, 5), ['a', 'b'])
  assert.deepEqual(move(['a', 'b'], -1, 0), ['a', 'b'])
})

test('add offers ready entries first, then the plain providers, never what is in the order', () => {
  const b = parseBackups(sample)
  assert.deepEqual(addable(b, ['codex']), ['claude:work', 'codex:deep', 'claude'])
  assert.deepEqual(addable(parseBackups({}), []), ['codex', 'claude'])
})

test('the policy note is for extra Claude accounts only', () => {
  assert.equal(hasClaudeAccount(['codex', 'claude:work']), true)
  assert.equal(hasClaudeAccount(['codex', 'claude', 'claude-api:main']), false)
})

test('an entry the host has not described yet still has a name and a login command', () => {
  const e = entryFor(parseBackups({}), 'codex')
  assert.equal(e.harness, 'codex')
  assert.equal(loginCommand(e), 'codex login')
  assert.equal(loginCommand(entryFor(parseBackups({}), 'claude:x')), null)
})
