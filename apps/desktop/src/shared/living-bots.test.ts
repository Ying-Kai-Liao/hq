import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLINK_MS,
  closedScale,
  doneDue,
  gradientTable,
  glyphColor,
  loopsOf,
  LOOK_IDLE_MS,
  MAX_FULL,
  phaseMs,
  PALETTE,
  seedOf,
  sizeTier,
} from './living-bots.ts'

// The designer's test vectors (MOTION.md section 3): iOS must give the same.
const vectors: [string, number, number, number, number, number, number][] = [
  ['builder', 3828680000, 0, 2, 0.08203125, 0.20703125, 0.890625],
  ['coder', 3469596402, 2, 1, 0.3583984375, 0.8037109375, 0.8046875],
  ['designer', 3572601220, 0, 1, 0.2734375, 0.943359375, 0.828125],
  ['lab', 1650496244, 0, 2, 0.2958984375, 0.376953125, 0.3828125],
]

test('a bot id picks the same loops and phases as the spec says', () => {
  for (const [id, seed, look, blink, fLook, fBlink, fBody] of vectors) {
    assert.equal(seedOf(id), seed, id)
    assert.deepEqual(loopsOf(id), { lookTrack: look, blinkTrack: blink, fLook, fBlink, fBody }, id)
  }
})

test('the loop lengths come from tracks.json', () => {
  assert.deepEqual(LOOK_IDLE_MS, [14370, 15870, 14770, 16770])
  assert.deepEqual(BLINK_MS, [30300, 27400, 29700])
})

test('builder at mount time 0 starts 1178.8 ms into look-idle-0', () => {
  const { fLook } = loopsOf('builder')
  assert.equal(Math.round(phaseMs(LOOK_IDLE_MS[0]!, fLook, 0) * 10) / 10, 1178.8)
  assert.equal(phaseMs(1000, 0.5, 700), 200)
})

test('size tiers: full from 40, blink 16 to 39.99, static below', () => {
  assert.equal(sizeTier(92), 'full')
  assert.equal(sizeTier(40), 'full')
  assert.equal(sizeTier(39.99), 'blink')
  assert.equal(sizeTier(16), 'blink')
  assert.equal(sizeTier(15.99), 'static')
  assert.equal(sizeTier(11), 'static')
  assert.equal(MAX_FULL, 6)
})

test('a closed eye is at least 10% and about 0.75 px tall', () => {
  assert.equal(closedScale(0.15, 92), 0.1)
  assert.ok(Math.abs(closedScale(0.15, 24) - 0.2083) < 0.001)
})

test('the done one-shot needs a second of work and a four second gap', () => {
  assert.equal(doneDue(999, 10000), false)
  assert.equal(doneDue(1000, 3999), false)
  assert.equal(doneDue(1000, 4000), true)
  assert.equal(doneDue(1000, Infinity), true)
})

test('the gradient table runs from colour a to colour b', () => {
  const pair = PALETTE.find((c) => c.id === 'coral')!
  const table = gradientTable(pair.a, pair.b)
  assert.equal(table.length, 256)
  assert.deepEqual(table[0], [0xff, 0x7e, 0x8e])
  assert.deepEqual(table[255], [0xff, 0xd1, 0xbf])
})

test('the coder glyph is a darker take on colour a', () => {
  const [r, g, b] = glyphColor('#5ED3F3')
  assert.ok(r + g + b < 0x5e + 0xd3 + 0xf3)
})
