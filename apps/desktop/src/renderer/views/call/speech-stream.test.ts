import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ECHO_WINDOW_CHARS, isEcho, rememberSpoken, SentenceStream, sentenceEnd, shouldCue, stripEcho, wordCount } from './speech-stream.ts'

test('sentenceEnd ignores dots inside numbers and file names', () => {
  assert.equal(sentenceEnd('Version 3.5 is out'), 0)
  assert.equal(sentenceEnd('Open a.ts now'), 0)
  assert.equal(sentenceEnd('One. Two'), 4)
  assert.equal(sentenceEnd('Done!'), 0) // at the very end: the next update confirms it
  assert.equal(sentenceEnd('你好。再'), 3)
})

test('a growing reply is spoken one finished sentence at a time, never repeated', () => {
  const s = new SentenceStream()
  assert.equal(s.feed('a', 'Hel', false), '')
  assert.equal(s.feed('a', 'Hello there. I am', false), 'Hello there.')
  assert.equal(s.feed('a', 'Hello there. I am here. Next', false), 'I am here.')
  assert.equal(s.feed('a', 'Hello there. I am here. Next', false), '')
  assert.equal(s.open, true)
  assert.equal(s.feed('a', 'Hello there. I am here. Next one', true), 'Next one')
  assert.equal(s.open, false)
  assert.equal(s.feed('a', 'Hello there. I am here. Next one', true), '')
})

test('code blocks and markdown are not spoken while streaming', () => {
  const s = new SentenceStream()
  assert.equal(s.feed('a', 'Run this. \n```sh\nls -la. \n', false), 'Run this.')
  assert.equal(s.feed('a', 'Run this. \n```sh\nls -la. \n```\nThen **wait** for it. Ok', false), 'Then wait for it.')
})

test('a rewrite of spoken text waits for the end and says only the sentences after it', () => {
  const s = new SentenceStream()
  assert.equal(s.feed('a', 'First sentence. Second', false), 'First sentence.')
  assert.equal(s.feed('a', 'Changed sentence. Second one. Third', false), '')
  assert.equal(s.feed('a', 'Changed sentence. Second one. Third.', true), 'Second one. Third.')
})

test('muting open replies stops their speech but not a later reply', () => {
  const s = new SentenceStream()
  assert.equal(s.feed('a', 'One. Two', false), 'One.')
  s.muteOpen()
  assert.equal(s.open, false)
  assert.equal(s.feed('a', 'One. Two. Three. x', false), '')
  assert.equal(s.feed('a', 'One. Two. Three. x', true), '')
  assert.equal(s.feed('b', 'Fresh reply.', true), 'Fresh reply.')
})

test('an entry that is first seen final is spoken whole', () => {
  assert.equal(new SentenceStream().feed('a', 'All of it', true), 'All of it')
})

test('wordCount counts CJK characters as half', () => {
  assert.equal(wordCount('hello there'), 2)
  assert.equal(wordCount('stop'), 1)
  assert.equal(wordCount('你好'), 1)
  assert.equal(wordCount('你好嗎今天'), 2.5)
})

const spoken = 'The build finished without errors. Three tests were skipped because they need a network connection.'

test('isEcho matches the spoken text, also with a misheard word', () => {
  assert.equal(isEcho('the build finished without errors', spoken), true)
  assert.equal(isEcho('three tests were skipped because they need a network', spoken), true)
  assert.equal(isEcho('three tests were skipped because they meet a network connection', spoken), true)
  assert.equal(isEcho('the build finished with errors', spoken), false)
  assert.equal(isEcho('wait stop that', spoken), false)
  assert.equal(isEcho('', spoken), true)
})

test('stripEcho drops the bot words from the start of the running transcript', () => {
  assert.equal(stripEcho('the build finished without errors what about the lint', spoken), 'what about the lint')
  assert.equal(stripEcho('the build finished without errors', spoken), '')
  assert.equal(stripEcho('what about the lint', spoken), 'what about the lint')
  // two copied words aren't enough to be sure
  assert.equal(stripEcho('the build please', spoken), 'the build please')
  assert.equal(stripEcho('anything', ''), 'anything')
})

test('shouldCue fires once, only while working and silent', () => {
  const base = { now: 6000, sentAt: 1000, lastSpokenAt: 0, working: true, cued: false }
  assert.equal(shouldCue(base), true)
  assert.equal(shouldCue({ ...base, now: 5999 }), false)
  assert.equal(shouldCue({ ...base, cued: true }), false)
  assert.equal(shouldCue({ ...base, working: false }), false)
  assert.equal(shouldCue({ ...base, lastSpokenAt: 3000 }), false)
  assert.equal(shouldCue({ ...base, sentAt: null }), false)
})

test('stripEcho drops the bot greeting heard by the on-device recognizer, keeps the user part', () => {
  const greeting = 'Hello, what can I do for you today?'
  assert.equal(stripEcho("Hello, what can I do for you today? check what's expiring", greeting), "check what's expiring")
  assert.equal(stripEcho('Hello what can I do for you today', greeting), '')
  // fewer than three words in a row from the bot is the user's own
  assert.equal(stripEcho('yes check the pantry', 'Should I check the pantry or the fridge?'), 'yes check the pantry')
})

test('rememberSpoken keeps only the latest window', () => {
  const kept = rememberSpoken('old', 'word '.repeat(400))
  assert.equal(kept.length, ECHO_WINDOW_CHARS)
  assert.ok(rememberSpoken('', 'hi').endsWith('hi'))
})
