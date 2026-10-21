import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avatarImage, crewName } from './crew.ts'

const bot = (id: string, name: string, kind = 'agent', avatarSource?: string) => ({ id, name, kind, avatarSource })

test('a bot named for a crew member takes that crew avatar', () => {
  assert.equal(crewName(bot('b1', 'house')), 'house')
  assert.equal(crewName(bot('b2', 'Coder')), 'coder')
  assert.equal(crewName(bot('b3', 'Resource Manager')), 'resource-manager')
})

test('the bot id matches too, with or without an hq prefix', () => {
  assert.equal(crewName(bot('hq-sound', 'Sound helper')), 'sound')
  assert.equal(crewName(bot('video', 'My bot')), 'video')
})

test('other bots and groups have no crew name', () => {
  assert.equal(crewName(bot('b4', 'Sam')), null)
  assert.equal(crewName(bot('house', 'house', 'group')), null)
})

test('auto shows the matching crew portrait, else the default hammer bot', () => {
  assert.deepEqual(avatarImage(bot('b1', 'house')), { kind: 'crew', name: 'house' })
  assert.deepEqual(avatarImage(bot('b2', 'seo', 'agent', 'auto')), { kind: 'crew', name: 'builder' })
})

test('a host that sends no avatarSource means auto', () => {
  assert.deepEqual(avatarImage({ id: 'b', name: 'Sam', kind: 'agent' }), { kind: 'crew', name: 'builder' })
})

test('an explicit crew or spare image wins over the name', () => {
  assert.deepEqual(avatarImage(bot('b', 'house', 'agent', 'crew:video')), { kind: 'crew', name: 'video' })
  assert.deepEqual(avatarImage(bot('b', 'Sam', 'agent', 'spare:gradcap')), { kind: 'spare', name: 'gradcap' })
})

test('shape draws the Codync character, groups keep their own avatar', () => {
  assert.equal(avatarImage(bot('b', 'house', 'agent', 'shape')), null)
  assert.equal(avatarImage(bot('g', 'Room', 'group')), null)
})

test('an image this app does not know falls back to auto', () => {
  assert.deepEqual(avatarImage(bot('b', 'Sam', 'agent', 'crew:nobody')), { kind: 'crew', name: 'builder' })
  assert.deepEqual(avatarImage(bot('b', 'Sam', 'agent', 'spare:nope')), { kind: 'crew', name: 'builder' })
  assert.deepEqual(avatarImage(bot('b', 'Sam', 'agent', 'future:thing')), { kind: 'crew', name: 'builder' })
})
