import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClipQueue, clips } from './speech-clips.ts'

test('clips groups sentences up to the limit', () => {
  assert.deepEqual(clips('One. Two. Three.', 10), ['One. Two.', 'Three.'])
  assert.deepEqual(clips('Hello there.', 100), ['Hello there.'])
  assert.deepEqual(clips('  ', 10), [])
})

test('clips cuts a sentence longer than the limit', () => {
  assert.deepEqual(clips('abcdefgh', 3), ['abc', 'def', 'gh'])
})

test('clips splits on CJK punctuation and newlines', () => {
  assert.deepEqual(clips('你好。再見！\nOK', 4), ['你好。', '再見！', 'OK'])
})

const deferred = <T>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

test('ClipQueue prefetches the next clip once one is handed out', async () => {
  const asked: string[] = []
  const q = new ClipQueue<string>(async (t) => (asked.push(t), t.toUpperCase()))
  q.add(['a', 'b', 'c'])
  assert.equal(await q.take(), 'A')
  assert.deepEqual(asked, ['a', 'b'])
  assert.equal(await q.take(), 'B')
  assert.equal(await q.take(), 'C')
  assert.equal(await q.take(), null)
  assert.equal(q.pending, false)
})

test('ClipQueue drops a clip that arrives after stop', async () => {
  const slow = deferred<string | null>()
  const q = new ClipQueue<string>(() => slow.promise)
  q.add(['a', 'b'])
  const taken = q.take()
  q.stop()
  slow.resolve('late')
  assert.equal(await taken, null)
  assert.equal(q.pending, false)
  // A new reply after the stop starts clean.
  const fresh = new ClipQueue<string>(async (t) => t)
  fresh.add(['x'])
  assert.equal(await fresh.take(), 'x')
})

test('ClipQueue ends on a clip that failed', async () => {
  const q = new ClipQueue<string>(async () => null)
  q.add(['a', 'b'])
  assert.equal(await q.take(), null)
})
