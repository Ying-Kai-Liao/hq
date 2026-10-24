import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAppearance } from './appearance.ts'

test('known values pass through', () => {
  assert.equal(parseAppearance('light'), 'light')
  assert.equal(parseAppearance('dark'), 'dark')
  assert.equal(parseAppearance('system'), 'system')
})

test('missing or unknown values mean System', () => {
  for (const v of [undefined, null, '', 'sepia', 3, {}]) assert.equal(parseAppearance(v), 'system')
})
