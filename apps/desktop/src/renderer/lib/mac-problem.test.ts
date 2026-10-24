import assert from 'node:assert/strict'
import { test } from 'node:test'
import { macProblem, type MacProblemInput } from './mac-problem.ts'

const base: MacProblemInput = {
  kind: 'relay', shown: true, hasStore: true, action: 'disconnect', mismatch: false, openInvite: false,
  connection: { kind: 'computerOffline', lastSeen: 1000 },
}
const seen = () => 'yesterday'
const of = (patch: Partial<MacProblemInput>) => macProblem('Studio', { ...base, ...patch }, seen)

test('an offline Mac shows a Reconnect card with when it was last seen', () => {
  const p = of({})
  assert.equal(p?.title, 'Studio is offline')
  assert.equal(p?.detail, "Last seen yesterday. Its agents pick up again when it's back.")
  assert.equal(p?.button, 'reconnect')
})

test('no last seen leaves that out', () => {
  assert.equal(of({ connection: { kind: 'computerOffline', lastSeen: null } })?.detail, "Its agents pick up again when it's back.")
})

test("a Mac that can't be reached offers Reconnect", () => {
  const p = of({ connection: { kind: 'offline', message: 'x' } })
  assert.equal(p?.title, "Can't reach Studio")
  assert.equal(p?.button, 'reconnect')
})

test('removed access offers Forget with the host message or the default', () => {
  assert.equal(of({ action: 'forget', connection: { kind: 'unauthorized', message: 'Revoked' } })?.detail, 'Revoked')
  const p = of({ action: 'forget', connection: { kind: 'unauthorized', message: '' } })
  assert.equal(p?.detail, 'Access was removed on the Mac.')
  assert.equal(p?.button, 'forget')
})

test('nothing shows for online, connecting or unpaired Macs', () => {
  for (const kind of ['online', 'connecting', 'unpaired'] as const) assert.equal(of({ connection: { kind } }), null)
})

test('nothing shows for a mismatch, this Mac, SSH, hidden, open-invite or not-yet-set-up Macs', () => {
  assert.equal(of({ mismatch: true }), null)
  assert.equal(of({ kind: 'this' }), null)
  assert.equal(of({ kind: 'ssh' }), null)
  assert.equal(of({ shown: false }), null)
  assert.equal(of({ openInvite: true, connection: { kind: 'offline', message: 'Open the invite link on this computer.' } }), null)
  assert.equal(of({ hasStore: false }), null)
  assert.equal(of({ action: 'connect' }), null)
  assert.equal(of({ action: 'cancel' }), null)
})
