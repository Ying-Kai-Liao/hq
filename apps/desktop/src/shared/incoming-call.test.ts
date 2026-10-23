import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expireCalls, isCallAnswer, parseCall, parsePanelCall, reduceCalls } from './incoming-call.ts'

const event = (state: string, id = 'c1', extra: Record<string, unknown> = {}) =>
  parseCall({ type: 'call', call: { id, botId: 'b1', name: 'House', reason: 'the bill', state, remainingMs: 30_000, ...extra } }, 1_000)!

test('a ringing call is read with its own deadline; a call without an id is not a call', () => {
  const { call, ringing } = event('ringing')
  assert.equal(ringing, true)
  assert.deepEqual(call, { id: 'c1', botId: 'b1', threadId: null, name: 'House', reason: 'the bill', deadline: 31_000 })
  assert.equal(parseCall({ call: { botId: 'b' } }), null)
  assert.equal(parseCall({}), null)
  assert.equal(event('ringing', 'c2', { threadId: 't1' }).call.threadId, 't1')
})

test('a call shows once, and any answer from any device takes it away', () => {
  let calls = reduceCalls([], event('ringing'))
  calls = reduceCalls(calls, event('ringing'))
  assert.equal(calls.length, 1, 'a reconnect repeats the pending call')
  calls = reduceCalls(calls, event('ringing', 'c2'))
  assert.deepEqual(calls.map((c) => c.id), ['c1', 'c2'])
  for (const state of ['accepted', 'declined', 'missed']) {
    assert.deepEqual(reduceCalls(calls, event(state)).map((c) => c.id), ['c2'], state)
  }
  assert.deepEqual(reduceCalls([], event('accepted')), [], 'an answer for a call never seen is nothing')
})

test('a call whose ring is over leaves by itself, the others stay', () => {
  const calls = reduceCalls(reduceCalls([], event('ringing')), parseCall({ call: { id: 'c2', botId: 'b', state: 'ringing', remainingMs: 5_000 } }, 1_000)!)
  assert.equal(expireCalls(calls, 5_000), calls, 'nothing over: the same list')
  assert.deepEqual(expireCalls(calls, 6_000).map((c) => c.id), ['c1'])
  assert.deepEqual(expireCalls(calls, 31_000), [])
})

test('the panel only takes a well-formed call, and trims what it shows', () => {
  assert.equal(parsePanelCall(null), null)
  assert.equal(parsePanelCall({ id: '', name: 'House', deadline: 1 }), null)
  assert.equal(parsePanelCall({ id: 'c1', name: 'House' }), null)
  const call = parsePanelCall({ id: 'c1', name: 'House', reason: 'x'.repeat(900), bot: { nope: 1 }, deadline: 5 })!
  assert.equal(call.reason.length, 400)
  assert.equal(call.bot, null, 'a bot without an id is no bot')
  assert.equal(parsePanelCall({ id: 'c1', name: 'House', bot: { id: 'b1' }, deadline: 5 })?.bot?.id, 'b1')
  assert.equal(isCallAnswer('accept') && isCallAnswer('decline'), true)
  assert.equal(isCallAnswer('remind'), false)
})
