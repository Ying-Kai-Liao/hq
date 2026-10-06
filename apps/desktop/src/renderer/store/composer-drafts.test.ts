import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComposerDrafts } from './composer-drafts.ts'

test('switching bots, threads and computers restores each exact draft', () => {
  const first = new ComposerDrafts()
  const second = new ComposerDrafts()
  const multiline = 'Unfinished message\n  with spacing and @mention '
  first.set('bot', null, multiline)
  first.set('other', null, 'Another bot')
  first.set('bot', 'thread', 'Thread reply')
  second.set('bot', null, 'Another computer')
  assert.equal(first.get('bot'), multiline)
  assert.equal(first.get('other'), 'Another bot')
  assert.equal(first.get('bot', 'thread'), 'Thread reply')
  assert.equal(first.get('bot', 'another-thread'), '')
  assert.equal(second.get('bot'), 'Another computer')
})

test('sending consumes only that destination and cannot clear a later draft', async () => {
  const drafts = new ComposerDrafts()
  drafts.set('bot', null, 'Message being sent')
  drafts.set('bot', 'thread', 'Unsent reply')
  drafts.set('other', null, 'Unsent message')
  const sent = drafts.take('bot', null)
  assert.equal(sent, 'Message being sent')
  assert.equal(drafts.get('bot'), '')
  drafts.set('bot', null, 'Next unfinished message')
  await Promise.resolve(sent)
  assert.equal(drafts.get('bot'), 'Next unfinished message')
  assert.equal(drafts.get('bot', 'thread'), 'Unsent reply')
  assert.equal(drafts.get('other'), 'Unsent message')
})

test('blank text is retained unless there are attachments to send', () => {
  const drafts = new ComposerDrafts()
  drafts.set('bot', null, ' \n ')
  assert.equal(drafts.take('bot', null), null)
  assert.equal(drafts.get('bot'), ' \n ')
  assert.equal(drafts.take('bot', null, true), ' \n ')
  assert.equal(drafts.get('bot'), '')
  assert.equal(drafts.take('bot', null, true), '')
})

test('deleting a bot clears its chat and thread drafts; retiring a computer clears all', () => {
  const drafts = new ComposerDrafts()
  drafts.set('bot', null, 'Chat')
  drafts.set('bot', 'thread', 'Reply')
  drafts.set('other', null, 'Other chat')
  drafts.deleteBot('bot')
  assert.equal(drafts.get('bot'), '')
  assert.equal(drafts.get('bot', 'thread'), '')
  assert.equal(drafts.get('other'), 'Other chat')
  drafts.clear()
  assert.equal(drafts.get('other'), '')
})

test('mounted composers see edits and clears immediately, without retaining old subscriptions', () => {
  const drafts = new ComposerDrafts()
  const seen: string[] = []
  const unsubscribe = drafts.subscribe(() => seen.push(drafts.get('bot')))
  drafts.set('bot', null, 'Typing')
  drafts.set('bot', null, 'Typing')
  drafts.take('bot', null)
  assert.deepEqual(seen, ['Typing', ''])
  unsubscribe()
  drafts.set('bot', null, 'Later')
  assert.deepEqual(seen, ['Typing', ''])
})
