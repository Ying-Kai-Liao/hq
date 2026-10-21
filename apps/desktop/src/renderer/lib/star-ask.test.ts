import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SECOND_ASK_AFTER, afterStarAsk, dueStarAsk } from './star-ask.ts'

test('asks right away, then once more after a week, then never', () => {
  assert.equal(dueStarAsk({ kind: 'never' }, 0), 'first')
  const asked = afterStarAsk({ kind: 'never' }, false, 100)
  assert.deepEqual(asked, { kind: 'asked', at: 100 })
  assert.equal(dueStarAsk(asked, 100 + SECOND_ASK_AFTER - 1), null)
  assert.equal(dueStarAsk(asked, 100 + SECOND_ASK_AFTER), 'second')
  assert.deepEqual(afterStarAsk(asked, false, 0), { kind: 'done' })
  assert.equal(dueStarAsk({ kind: 'done' }, Number.MAX_SAFE_INTEGER), null)
})

test('starring at the first ask skips the second', () => {
  assert.deepEqual(afterStarAsk({ kind: 'never' }, true, 0), { kind: 'done' })
})
