import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComposerDrafts } from './composer-drafts.ts'

function storage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

test('drafts survive reopening with whitespace and isolate bots, threads and accounts', () => {
  const disk = storage()
  const drafts = new ComposerDrafts(disk, 'account/computer')
  const text = '  中文\nunfinished 🐱\n'
  drafts.set('bot', null, text)
  drafts.set('bot', 'thread', 'reply')
  drafts.set('other', null, 'other draft')
  const reopened = new ComposerDrafts(disk, 'account/computer')
  assert.equal(reopened.get('bot'), text)
  assert.equal(reopened.get('bot', 'thread'), 'reply')
  assert.equal(reopened.get('other'), 'other draft')
  assert.equal(new ComposerDrafts(disk, 'other-account/computer').get('bot'), '')
  assert.equal(new ComposerDrafts(disk, 'account/other-computer').get('bot'), '')
  reopened.set('bot', null, '')
  assert.equal(new ComposerDrafts(disk, 'account/computer').get('bot'), '')
  assert.equal(reopened.get('bot', 'thread'), 'reply')
  assert.equal(reopened.get('other'), 'other draft')
})

test('deleting a bot removes its main and thread drafts, but preserves other bots', () => {
  const drafts = new ComposerDrafts(storage(), 'drafts')
  drafts.set('bot', null, 'main')
  drafts.set('bot', 'thread', 'reply')
  drafts.set('other', null, 'keep')
  drafts.removeBot('bot')
  assert.equal(drafts.get('bot'), '')
  assert.equal(drafts.get('bot', 'thread'), '')
  assert.equal(drafts.get('other'), 'keep')
})

test('malformed or unavailable persistence does not destroy editable in-memory text', () => {
  const disk = { getItem: () => '{bad', setItem: () => { throw new Error('full') } }
  const drafts = new ComposerDrafts(disk, 'drafts')
  let updates = 0
  const unsubscribe = drafts.subscribe(() => updates++)
  drafts.set('bot', null, 'kept')
  assert.equal(drafts.get('bot'), 'kept')
  assert.equal(updates, 1)
  unsubscribe()
  drafts.set('bot', null, 'next')
  assert.equal(updates, 1)
})

test('late edits from a retired store cannot overwrite a reopened conversation', () => {
  const disk = storage()
  const previous = new ComposerDrafts(disk, 'account/computer')
  previous.set('bot', null, 'old text')
  previous.retire()
  const current = new ComposerDrafts(disk, 'account/computer')
  current.set('bot', null, 'new text')
  previous.set('bot', null, 'late edit')
  previous.clear()
  assert.equal(new ComposerDrafts(disk, 'account/computer').get('bot'), 'new text')
})
