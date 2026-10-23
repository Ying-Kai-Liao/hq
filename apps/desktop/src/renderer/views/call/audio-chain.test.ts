import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BargeInDetector, decodeWav, fadeEdges, levelToDb, PlaybackSchedule, type BargeEvent } from './audio-chain.ts'

function wav(samples: number[], rate = 24000, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true))
  return out
}

test('a WAV decodes to floats at its own rate', () => {
  const clip = decodeWav(wav([0, 16384, -16384, -32768]))
  assert.equal(clip?.sampleRate, 24000)
  assert.deepEqual([...clip!.samples], [0, 0.5, -0.5, -1])
})

test('a stereo WAV is averaged', () => {
  assert.deepEqual([...decodeWav(wav([16384, 0, -16384, -16384], 24000, 2))!.samples], [0.25, -0.5])
})

test('something that is not a WAV decodes to null', () => {
  assert.equal(decodeWav(new TextEncoder().encode('hello')), null)
  assert.equal(decodeWav(new Uint8Array()), null)
})

test('a streamed WAV with size 0 takes what is there', () => {
  const data = wav([1000, 2000, 3000])
  new DataView(data.buffer).setUint32(40, 0, true)
  assert.equal(decodeWav(data)?.samples.length, 3)
})

test('the fade silences the edges and leaves the middle', () => {
  const s = new Float32Array(2400).fill(1) // 100 ms at 24 kHz; the fade is 120 samples
  fadeEdges(s, 24000)
  assert.equal(s[0], 0)
  assert.equal(s[2399], 0)
  assert.ok(s[60]! > 0.45 && s[60]! < 0.55)
  assert.equal(s[1200], 1)
  assert.equal(s[2399 - 119], s[119])
})

test('the fade never reaches past half the clip', () => {
  const s = new Float32Array(3).fill(1)
  fadeEdges(s, 24000)
  assert.deepEqual([...s], [0, 1, 0])
})

test('clips queue back to back, with no gap', () => {
  const q = new PlaybackSchedule(0.02)
  const a = q.add(10, 1)
  const b = q.add(10.1, 0.5) // arrives while a plays
  const c = q.add(10.2, 0.5)
  assert.equal(a.at, 10.02)
  assert.ok(Math.abs(b.at - 11.02) < 1e-9)
  assert.ok(Math.abs(c.at - 11.52) < 1e-9)
})

test('a clip after the queue ran dry starts just ahead of now', () => {
  const q = new PlaybackSchedule(0.02)
  const a = q.add(10, 1)
  assert.equal(q.done(a.token), true)
  const b = q.add(20, 1)
  assert.equal(b.at, 20.02)
})

test('the schedule drains on the last clip and ignores completions from before a cut', () => {
  const q = new PlaybackSchedule()
  const a = q.add(0, 1)
  const b = q.add(0, 1)
  assert.equal(q.idle, false)
  assert.equal(q.done(a.token), false)
  assert.equal(q.done(b.token), true)
  assert.equal(q.idle, true)
  const old = q.add(0, 1)
  q.cut()
  const fresh = q.add(0, 1)
  assert.equal(fresh.at, 0.02) // the cut forgot where the old queue ended
  assert.equal(q.done(old.token), false)
  assert.equal(q.idle, false)
  assert.equal(q.done(fresh.token), true)
})

// Talk-over detector, fed synthetic frames (no microphone in CI).

/** `ms` of constant loudness in 10 ms frames; each event with the time it fired. */
function run(d: BargeInDetector, db: number, ms: number, from = 0, armed = true) {
  const events: [BargeEvent, number][] = []
  for (let t = from + 10; t <= from + ms; t += 10) {
    const e = d.feed(db, 0.01, t / 1000, armed)
    if (e) events.push([e, t])
  }
  return events
}
const kinds = (events: [BargeEvent, number][]) => events.map((e) => e[0])

test('speech over the voice ducks, then stops', () => {
  const d = new BargeInDetector()
  run(d, -62, 500) // a quiet room teaches the floor
  const events = run(d, -30, 500, 500)
  assert.deepEqual(kinds(events), ['duck', 'stop'])
  // Expected latency from the first loud frame in the harness: duck at 100 ms, stop at 400 ms.
  assert.equal(events[0]![1] - 510, 90)
  assert.equal(events[1]![1] - 510, 390)
  assert.equal(d.onsetAt, 0.51)
})

test('a cough ducks, then the voice comes back', () => {
  const d = new BargeInDetector()
  run(d, -62, 500)
  const events = [...run(d, -30, 130, 500), ...run(d, -62, 500, 630)]
  assert.deepEqual(kinds(events), ['duck', 'resume'])
})

test('short gaps between words only slow the count', () => {
  const d = new BargeInDetector()
  run(d, -62, 500)
  const events = [...run(d, -30, 300, 500), ...run(d, -62, 50, 800), ...run(d, -30, 250, 850)]
  assert.deepEqual(kinds(events), ['duck', 'stop'])
})

test('loudspeaker echo in syllable bursts never adds up to a stop', () => {
  const d = new BargeInDetector()
  run(d, -62, 500)
  const events: [BargeEvent, number][] = []
  for (let t = 500; t < 2500; t += 200) events.push(...run(d, -30, 100, t), ...run(d, -62, 100, t + 100))
  assert.ok(!kinds(events).includes('stop'))
})

test('a blip too short to duck does nothing', () => {
  const d = new BargeInDetector()
  run(d, -62, 500)
  assert.deepEqual([...run(d, -30, 50, 500), ...run(d, -62, 500, 550)], [])
})

test('nothing fires while the voice is not playing', () => {
  assert.deepEqual(run(new BargeInDetector(), -20, 1000, 0, false), [])
})

test('steady room noise lifts the floor instead of triggering', () => {
  const d = new BargeInDetector()
  run(d, -62, 300)
  const events = [...run(d, -50, 3000, 300, false), ...run(d, -50, 1000, 3300)]
  assert.deepEqual(events, [])
  assert.ok(d.floorDb > -55)
})

test('the next talk-over starts fresh', () => {
  const d = new BargeInDetector()
  run(d, -62, 500)
  assert.deepEqual(kinds(run(d, -30, 500, 500)), ['duck', 'stop'])
  run(d, -62, 100, 1000, false) // the voice was cut
  assert.deepEqual(kinds(run(d, -30, 500, 1100)), ['duck', 'stop'])
})

test('the helper level maps back to dBFS', () => {
  assert.equal(levelToDb(0), -50)
  assert.equal(levelToDb(1), 0)
  assert.equal(levelToDb(0.5), -25)
})
