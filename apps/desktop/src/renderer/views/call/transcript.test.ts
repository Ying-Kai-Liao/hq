import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Captions, MAX_CAPTIONS } from './transcript.ts'

test('a revised utterance replaces its line, then settles', () => {
  const c = new Captions()
  c.hearing('hel')
  c.hearing('hello there')
  assert.equal(c.lines.length, 1)
  assert.deepEqual([c.lines[0]!.who, c.lines[0]!.text, c.lines[0]!.live], ['you', 'hello there', true])
  c.settleYou()
  assert.equal(c.lines[0]!.live, false)
  c.hearing('again')
  assert.equal(c.lines.length, 2)
})

test('an emptied utterance leaves no line', () => {
  const c = new Captions()
  c.hearing('hm')
  c.hearing('  ')
  assert.deepEqual(c.lines, [])
})

test('spoken sentences join into one bot line until the user speaks', () => {
  const c = new Captions()
  c.hearing('hi')
  c.said('Hello.')
  c.said('How can I help?')
  assert.equal(c.lines.length, 2)
  assert.equal(c.lines[0]!.live, false)
  assert.equal(c.lines[1]!.text, 'Hello. How can I help?')
  c.settleBot()
  assert.equal(c.lines[1]!.live, false)
  c.said('More.')
  assert.equal(c.lines[1]!.text, 'Hello. How can I help? More.')
})

test('talking over the bot starts a new line after it', () => {
  const c = new Captions()
  c.said('Long answer')
  c.settleBot()
  c.hearing('wait')
  assert.deepEqual(c.lines.map((l) => l.who), ['bot', 'you'])
})

test('only the recent lines are kept', () => {
  const c = new Captions()
  for (let i = 0; i < MAX_CAPTIONS + 5; i++) {
    c.hearing(`line ${i}`)
    c.settleYou()
  }
  assert.equal(c.lines.length, MAX_CAPTIONS)
  assert.equal(c.lines[MAX_CAPTIONS - 1]!.text, `line ${MAX_CAPTIONS + 4}`)
})
