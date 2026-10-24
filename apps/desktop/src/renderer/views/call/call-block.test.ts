import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callBlock } from './call-block.ts'

const ok = { offline: false, mismatch: false, voiceReady: true, unavailableReason: () => 'No voice.' }

test('a ready call is not blocked', () => assert.equal(callBlock(ok), null))
test('an offline computer blocks with a reason', () => assert.match(callBlock({ ...ok, offline: true }) ?? '', /offline/))
test('a version mismatch blocks with a reason', () => assert.match(callBlock({ ...ok, mismatch: true }) ?? '', /Update Kith/))
test('no voice at all names the way out', () => assert.match(callBlock({ ...ok, voiceReady: false }) ?? '', /No voice\. Pick a cloud voice/))
test('offline wins over the voice', () => assert.match(callBlock({ ...ok, offline: true, voiceReady: false }) ?? '', /offline/))
