import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callLineSuffix } from './call-line.ts'

const now = 1_000_000_000

test('a finished call shows its length', () => {
  assert.equal(callLineSuffix({ callSeconds: 76 }, now), ' · 01:16')
  assert.equal(callLineSuffix({ callSeconds: 0 }, now), ' · 00:00')
})

test('a live call is in progress until it goes stale', () => {
  assert.equal(callLineSuffix({ callLive: true }, now - 60_000, now), ' · in progress')
  assert.equal(callLineSuffix({ callLive: true }, now - 4 * 3600_000, now), '')
})

test('other notices are not calls', () => {
  assert.equal(callLineSuffix({}, now), null)
})
