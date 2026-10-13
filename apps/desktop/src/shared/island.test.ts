import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BotStatus } from './models.ts'
import { hitRect, hits, islandFrame, islandMode, islandRect, justFinished, notchOf, type IslandBot, type IslandPermission, type IslandSummary } from './island.ts'

const bot = (ref: string, status: BotStatus): IslandBot => ({ ref, name: ref, shape: 'circle', color: 'blue', status, detail: '' })
const card = (entryId: string): IslandPermission => ({
  ref: 'c/a', entryId, bot: { name: 'a', shape: 'circle', color: 'blue' }, headline: 'Wants to run a command', title: 'ls', options: [], answering: null,
})
const summary = (bots: IslandBot[], permissions: IslandPermission[] = []): IslandSummary => ({ bots, permissions })
const none = new Set<string>()

test('the island hides with nothing running and stays thin while bots work', () => {
  assert.equal(islandMode(summary([bot('a', 'idle')]), { open: false, deferred: none, finished: false }), 'hidden')
  assert.equal(islandMode(summary([bot('a', 'working')]), { open: false, deferred: none, finished: false }), 'compact')
  assert.equal(islandMode(summary([bot('a', 'needsInput')]), { open: false, deferred: none, finished: false }), 'compact')
  assert.equal(islandMode(summary([bot('a', 'idle')]), { open: false, deferred: none, finished: true }), 'finished')
  assert.equal(islandMode(summary([bot('a', 'working')]), { open: true, deferred: none, finished: true }), 'bots')
})

test('an approval opens the island until it is put off, and opening shows it again', () => {
  const s = summary([bot('a', 'needsInput')], [card('e1')])
  assert.equal(islandMode(s, { open: false, deferred: none, finished: false }), 'approval')
  assert.equal(islandMode(s, { open: false, deferred: new Set(['e1']), finished: false }), 'compact')
  assert.equal(islandMode(s, { open: true, deferred: new Set(['e1']), finished: false }), 'approval')
  // A new card arrives while the first is put off.
  assert.equal(islandMode(summary([], [card('e1'), card('e2')]), { open: false, deferred: new Set(['e1']), finished: false }), 'approval')
})

test('only bots that were working count as finished', () => {
  const before = new Map<string, BotStatus>([['a', 'working'], ['b', 'idle'], ['c', 'needsInput'], ['d', 'working']])
  const after = [bot('a', 'idle'), bot('b', 'idle'), bot('c', 'error'), bot('d', 'working'), bot('e', 'idle')]
  assert.deepEqual(justFinished(before, after).map((b) => b.ref), ['a', 'c'])
})

test('the notch is the screen width minus the menu bar on both sides', () => {
  const screens = [
    { x: 0, width: 1512, top: 32, left: 663.5, right: 663.5 },
    { x: 1512, width: 2560, top: 0, left: 0, right: 0 },
  ]
  assert.deepEqual(notchOf(screens, { x: 0, width: 1512 }), { width: 185, height: 32 })
  assert.equal(notchOf(screens, { x: 1512, width: 2560 }), null)
  assert.equal(notchOf([], { x: 0, width: 1512 }), null)
})

test('the hidden island covers the notch, or leaves a thin strip at a plain top edge', () => {
  const notch = { notch: { width: 185, height: 32 } }
  assert.deepEqual(islandFrame('hidden', notch, 0), { width: 185, height: 32, radius: 10 })
  assert.equal(islandFrame('compact', notch, 0).width, 185 + 72)
  assert.equal(islandFrame('approval', notch, 100).height, 32 + 100 + 14)
  const edge = islandRect(islandFrame('hidden', { notch: null }, 0), 720)
  assert.equal(hits(edge, 360, 0), true)
  assert.equal(hits(edge, 360, 12), false)
  assert.equal(hits(edge, 100, 0), false)
  // Linux shapes the window to this: the strip under the top edge, never above the window.
  assert.deepEqual(hitRect(edge), { x: 272, y: 0, width: 176, height: 8 })
  assert.deepEqual(hitRect({ x: 0, y: 0, width: 0, height: 0 }), { x: 0, y: 0, width: 0, height: 0 })
})
