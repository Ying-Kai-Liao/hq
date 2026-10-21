import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crewName } from './crew.ts'

const bot = (id: string, name: string, kind = 'agent') => ({ id, name, kind })

test('a bot named for a crew member takes that crew avatar', () => {
  assert.equal(crewName(bot('b1', 'house')), 'house')
  assert.equal(crewName(bot('b2', 'Coder')), 'coder')
  assert.equal(crewName(bot('b3', 'Resource Manager')), 'resource-manager')
})

test('the bot id matches too, with or without an hq prefix', () => {
  assert.equal(crewName(bot('hq-sound', 'Sound helper')), 'sound')
  assert.equal(crewName(bot('video', 'My bot')), 'video')
})

test('other bots and groups keep the character avatar', () => {
  assert.equal(crewName(bot('b4', 'Sam')), null)
  assert.equal(crewName(bot('house', 'house', 'group')), null)
})
