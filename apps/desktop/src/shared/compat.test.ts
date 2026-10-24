import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkHost, hostHas, isBelow, parseVersion } from './compat.ts'

test('versions parse like the host and the iPhone app', () => {
  assert.deepEqual(parseVersion('v2.6'), [2, 6, 0])
  assert.deepEqual(parseVersion('2.6.3-beta+1'), [2, 6, 3])
  assert.equal(parseVersion('2.x'), null)
  assert.equal(isBelow('2.6.3', '2.7.0'), true)
  assert.equal(isBelow('2.10.0', '2.9.9'), false)
  assert.equal(isBelow('garbage', '9.9.9'), false)
})

test('a 0.1.0 host works with this app', () => {
  assert.equal(checkHost({ version: '0.1.0', protocol: 1, minProtocol: 1 }), null)
})

test('protocol levels decide the side that must update', () => {
  assert.deepEqual(checkHost({ version: '0.4.0', protocol: 3, minProtocol: 2 }), { kind: 'updateApp' })
  assert.deepEqual(checkHost({ version: '0.1.0', protocol: 1, minProtocol: 1 }, 1, 2), { kind: 'updateHost', version: '0.1.0' })
  assert.equal(checkHost({ version: '0.2.0', protocol: 2, minProtocol: 1 }), null)
})

test('a host from before protocol levels is checked by its version, not its minApp', () => {
  assert.equal(checkHost({ version: '2.20.0' }), null)
  assert.equal(checkHost({ version: '2.12.0' }), null)
  assert.deepEqual(checkHost({ version: '2.11.3' }), { kind: 'updateHost', version: '2.11.3' })
})

test('features legacy hosts got late are on every host with a protocol level', () => {
  assert.equal(hostHas({ version: '0.1.0', protocol: 1 }, '2.14.1'), true)
  assert.equal(hostHas({ version: '2.14.1' }, '2.14.1'), true)
  assert.equal(hostHas({ version: '2.13.0' }, '2.14.1'), false)
  assert.equal(hostHas(null, '2.14.1'), true)
})
