import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftOf, normalizeBot } from './models.ts'

test('a bot keeps its Fast mode through the settings draft', () => {
  const bot = normalizeBot({ id: 'b', backend: 'codex', fastMode: true })
  assert.equal(bot.fastMode, true)
  assert.equal(draftOf(bot).fastMode, true)
})

test('a host without Fast mode reads as off', () => {
  assert.equal(normalizeBot({ id: 'b' }).fastMode, false)
})

test('the composer offers Fast mode once the agent does, and while it is on', async () => {
  const { fastModeShown, fastModeState, fastModeTitle } = await import('./fast-mode.ts')
  assert.equal(fastModeShown(normalizeBot({ id: 'b' })), false)
  assert.equal(fastModeShown(normalizeBot({ id: 'b', fastModeSupport: 'offered' })), true)
  assert.equal(fastModeShown(normalizeBot({ id: 'b', fastMode: true, fastModeSupport: 'unsupported' })), true)
  assert.equal(fastModeShown(normalizeBot({ id: 'g', kind: 'group', fastModeSupport: 'offered' })), false)
  const refused = normalizeBot({ id: 'b', fastMode: true, fastModeSupport: 'refused', fastModeIssue: 'requires extra usage' })
  assert.equal(fastModeState(refused), 'refused')
  assert.match(fastModeTitle(refused), /requires extra usage/)
})
