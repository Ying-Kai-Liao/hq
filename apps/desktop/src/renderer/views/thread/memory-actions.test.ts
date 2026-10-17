import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryActions } from './memory-actions.ts'

test('a pending card asks for an answer; a saved memory offers undo; a settled one offers nothing', () => {
  assert.equal(memoryActions('pending'), 'answer')
  assert.equal(memoryActions('done'), 'undo')
  assert.equal(memoryActions('accepted'), 'undo')
  for (const status of ['declined', 'undone', 'failed', undefined, 'something-newer']) assert.equal(memoryActions(status), null)
})
