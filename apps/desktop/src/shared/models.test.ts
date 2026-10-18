import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftOf, isChat, normalizeBot, type Entry } from './models.ts'

test('a bot keeps its Fast mode through the settings draft', () => {
  const bot = normalizeBot({ id: 'b', backend: 'codex', fastMode: true })
  assert.equal(bot.fastMode, true)
  assert.equal(draftOf(bot).fastMode, true)
})

test('a host without Fast mode reads as off', () => {
  assert.equal(normalizeBot({ id: 'b' }).fastMode, false)
})

test('the composer offers Fast mode until the agent says it has none, and while it is on', async () => {
  const { fastModeShown, fastModeState, fastModeDetail } = await import('./fast-mode.ts')
  assert.equal(fastModeShown(normalizeBot({ id: 'b' })), true)
  assert.equal(fastModeShown(normalizeBot({ id: 'b', fastModeSupport: 'unsupported' })), false)
  assert.equal(fastModeShown(normalizeBot({ id: 'b', fastModeSupport: 'offered' })), true)
  assert.equal(fastModeShown(normalizeBot({ id: 'b', fastMode: true, fastModeSupport: 'unsupported' })), true)
  assert.equal(fastModeShown(normalizeBot({ id: 'g', kind: 'group', fastModeSupport: 'offered' })), false)
  const refused = normalizeBot({ id: 'b', fastMode: true, fastModeSupport: 'refused', fastModeIssue: 'requires extra usage' })
  assert.equal(fastModeState(refused), 'refused')
  assert.match(fastModeDetail(refused), /requires extra usage/)
})


test('memory lines and summaries stay out of the chat', () => {
  const notice = (data: Entry['data']) => ({ id: 'n', botId: 'b', threadId: null, kind: 'notice', rev: 1, turn: 1, createdAt: 0, data }) as Entry
  assert.equal(isChat(notice({ text: 'Remembered: likes tea', memory: { status: 'done' } })), false)
  assert.equal(isChat(notice({ text: 'Updated people.md', memoryFile: { status: 'done' } })), false)
  assert.equal(isChat(notice({ text: 'Earlier context was summarized to make room.', compaction: { byHost: true } })), false)
  assert.equal(isChat(notice({ text: 'Stopped.' })), true)
})

test('a kept handoff leaves no line; a fresh conversation does', () => {
  const notice = (status: string) => ({ id: 'n', botId: 'b', threadId: null, kind: 'notice', rev: 1, turn: 1, createdAt: 0, data: { text: '…', handoff: { status } } }) as Entry
  assert.equal(isChat(notice('kept')), false)
  assert.equal(isChat(notice('sent')), true)
  assert.equal(isChat(notice('draft')), true)
})
