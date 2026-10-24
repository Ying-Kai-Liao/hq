import assert from 'node:assert/strict'
import { createPrivateKey, sign as nodeSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { CHUNK, FrameOpener, FrameSealer, TooLarge, b64url, cat, signerFromSeed, unb64url, type Signer } from './crypto.ts'
import { vectorChecks } from './vectors.ts'

// The same file the iOS tests load (apps/ios/Kit/Tests/KithKitTests/RelayVectorsTests.swift).
const v = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../serve/docs/reference/fixtures/remote-relay-vectors.json'), 'utf8'))
const raw = (s: string) => unb64url(s) as Uint8Array

// The vectors run twice: with the pure-JS seed signer, and with Node's own Ed25519 behind a Promise like the desktop's
// device key, so a signer that isn't noble produces the same bytes.
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const nodeSigner = async (seed: Uint8Array): Promise<Signer> => {
  const key = createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' })
  return { publicKey: signerFromSeed(seed).publicKey, sign: async (m) => nodeSign(null, m, key) }
}

for (const [name, check] of Object.entries(vectorChecks)) {
  test(`vectors: ${name}`, () => check(v, async (seed) => signerFromSeed(seed)))
  test(`vectors (node:crypto signer): ${name}`, () => check(v, nodeSigner))
}

test('a sealer and opener round trip with chunking, and refuse gaps, bad tags and oversize', () => {
  const key = raw(v.handshake.kD2H)
  const sealer = new FrameSealer(key)
  const big = new Uint8Array(CHUNK * 2 + 10).fill(120)
  const frames = sealer.seal(big)
  assert.equal(frames.length, 3)
  assert.deepEqual(frames.map((f) => f.c), [0, 1, 2])
  const opener = new FrameOpener(key)
  assert.equal(opener.open(0, raw(frames[0].d)), null)
  assert.equal(opener.open(1, raw(frames[1].d)), null)
  assert.deepEqual(opener.open(2, raw(frames[2].d)), big)

  // An empty message is one final frame.
  assert.equal(new FrameSealer(key).seal(new Uint8Array(0)).length, 1)

  const next = sealer.seal(new TextEncoder().encode('hi'))
  assert.throws(() => new FrameOpener(key).open(5, raw(next[0].d)), /counter/)
  const tampered = Uint8Array.from(raw(next[0].d))
  tampered[2] ^= 1
  const o2 = new FrameOpener(key)
  assert.throws(() => o2.open(0, tampered), /decrypt/)

  const small = new FrameOpener(key, 100)
  const fresh = new FrameSealer(key).seal(new Uint8Array(200).fill(121))
  assert.throws(() => small.open(0, raw(fresh[0].d)), TooLarge)
})

test('strict base64url, and it agrees with Node on every length', () => {
  assert.equal(unb64url('AA+/'), null)
  assert.equal(unb64url('AAAAA'), null)
  assert.equal(unb64url('AAA='), null)
  assert.deepEqual(unb64url('AAA'), new Uint8Array(2))
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
    assert.equal(b64url(bytes), Buffer.from(bytes).toString('base64url'))
    assert.deepEqual(unb64url(b64url(bytes)), bytes)
  }
  assert.deepEqual(cat(Uint8Array.of(1), Uint8Array.of(2, 3)), Uint8Array.of(1, 2, 3))
})

test('base64url handles a 4 MiB message quickly and round-trips it', () => {
  const big = Uint8Array.from({ length: 4 * 1024 * 1024 + 1 }, (_, i) => (i * 31) & 255)
  const t0 = Date.now()
  const s = b64url(big)
  assert.deepEqual(unb64url(s), big)
  // ~10 ms natively; the bound is generous so a slow CI box passes, and a per-character loop (hundreds of ms) fails.
  assert.ok(Date.now() - t0 < 400, `took ${Date.now() - t0} ms`)
  assert.equal(s, Buffer.from(big).toString('base64url'))
})
