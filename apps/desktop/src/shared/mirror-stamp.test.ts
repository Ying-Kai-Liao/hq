import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mirrorStamp } from './mirror-stamp.ts'

test('a mirror saved before the schema field is stamped differently, so it is refetched', () => {
  assert.notEqual(mirrorStamp('0.1.0', '0.1.0'), '0.1.0/0.1.0')
  assert.equal(mirrorStamp('0.1.0', '0.1.0'), mirrorStamp('0.1.0', '0.1.0'))
  assert.notEqual(mirrorStamp('0.1.0', '0.1.0'), mirrorStamp('0.1.1', '0.1.0'))
})

test('a schema 2 stamp (bots without hqAgent) differs from the current one', () => {
  assert.notEqual(mirrorStamp('0.1.0', '0.2.0'), '0.1.0/0.2.0/s2')
  assert.equal(mirrorStamp('0.1.0', '0.2.0'), '0.1.0/0.2.0/s3')
})
