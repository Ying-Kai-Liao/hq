import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextLabel } from './context-hint.ts'

test('context hint: the number as is, also past 100', () => {
  assert.equal(contextLabel(42), 'context 42%')
  assert.equal(contextLabel(120), 'context 120%')
})

test('context hint: nothing when absent or not a number', () => {
  for (const v of [undefined, null, '42', NaN]) assert.equal(contextLabel(v), null)
})
