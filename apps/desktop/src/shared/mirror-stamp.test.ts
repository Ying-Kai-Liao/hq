import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mirrorStamp } from './mirror-stamp.ts'

test('a mirror saved before the schema field is stamped differently, so it is refetched', () => {
  assert.notEqual(mirrorStamp('2.19.1', '2.19.1'), '2.19.1/2.19.1')
  assert.equal(mirrorStamp('2.19.1', '2.19.1'), mirrorStamp('2.19.1', '2.19.1'))
  assert.notEqual(mirrorStamp('2.19.1', '2.19.1'), mirrorStamp('2.19.2', '2.19.1'))
})
