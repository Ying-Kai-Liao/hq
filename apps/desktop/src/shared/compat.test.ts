import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkHost } from './compat.ts'

test('a 0.1.0 host works with this app', () => {
  assert.equal(checkHost({ version: '0.1.0', protocol: 1, minProtocol: 1 }), null)
})

test('protocol levels decide the side that must update', () => {
  assert.deepEqual(checkHost({ version: '0.4.0', protocol: 3, minProtocol: 2 }), { kind: 'updateApp' })
  assert.deepEqual(checkHost({ version: '0.1.0', protocol: 1, minProtocol: 1 }, 1, 2), { kind: 'updateHost' })
  assert.equal(checkHost({ version: '0.2.0', protocol: 2, minProtocol: 1 }), null)
})

test('a host without a protocol level is level 0, whatever its version', () => {
  assert.deepEqual(checkHost({ version: '2.20.0' }), { kind: 'updateHost' })
  assert.deepEqual(checkHost({ version: '' }), { kind: 'updateHost' })
  assert.equal(checkHost({ version: '2.20.0' }, 1, 0), null)
})

test('a missing minProtocol is no floor on the app', () => {
  assert.equal(checkHost({ version: '0.1.0', protocol: 1 }), null)
  assert.equal(checkHost({ version: '0.1.0', protocol: 1, minProtocol: null }), null)
})
