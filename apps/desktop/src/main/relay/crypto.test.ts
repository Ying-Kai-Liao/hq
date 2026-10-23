import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CHUNK, FrameOpener, FrameSealer, Handshake, TooLarge, b64url, boxKey, computerIdOf, offerId, openFrame, sasCode, sasCommit, sealFrame,
  signatureHeader, signerFromSeed, unb64url, verify,
} from './crypto.ts'

// The same file the iOS tests load (apps/ios/Kit/Tests/KithKitTests/RelayVectorsTests.swift).
const v = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../serve/docs/reference/fixtures/remote-relay-vectors.json'), 'utf8'))
const raw = (s: string) => unb64url(s) as Buffer

const device = signerFromSeed(raw(v.keys.deviceSignSeed))
const hostPub = raw(v.keys.hostSignPub)

test('keys and the computer id', () => {
  assert.equal(b64url(device.publicKey), v.keys.deviceSignPub)
  assert.equal(b64url(signerFromSeed(raw(v.keys.hostSignSeed)).publicKey), v.keys.hostSignPub)
  assert.equal(b64url(boxKey(raw(v.keys.hostBoxPriv)).pub), v.keys.hostBoxPub)
  assert.equal(computerIdOf(hostPub), v.keys.computerId)
})

test('handshake: hello, transcript hash, shared secret and channel keys', () => {
  const h = v.handshake
  const eph = boxKey(raw(h.deviceEphPriv))
  assert.equal(b64url(eph.pub), h.deviceEphPub)
  const hs = new Handshake(device, hostPub, { eph, n: raw(h.n) })
  assert.equal(b64url(hs.signInput), h.hs1SignInput)
  const hello = hs.hello()
  assert.equal(hello.sig, h.hs1Sig)
  assert.deepEqual(Object.keys(hello), ['t', 'v', 'dk', 'ek', 'n', 'sig'])
  assert.equal(hs.hello(true).pair, true)

  assert.equal(b64url(boxKey(raw(h.hostEphPriv)).pub), h.hostEphPub)
  const keys = hs.finish(raw(h.hostEphPub), raw(h.hs2Sig))
  assert.equal(b64url((keys as unknown as { ss: Buffer }).ss), h.sharedSecret)
  assert.equal(b64url((keys as unknown as { prk: Buffer }).prk), h.prk)
  assert.equal(b64url(keys.d2h), h.kD2H)
  assert.equal(b64url(keys.h2d), h.kH2D)
})

test('handshake refuses a welcome signed by another key or over another transcript', () => {
  const h = v.handshake
  const hs = () => new Handshake(device, hostPub, { eph: boxKey(raw(h.deviceEphPriv)), n: raw(h.n) })
  const wrongHost = signerFromSeed(Buffer.alloc(32, 9))
  const th = raw(h.transcriptHash)
  assert.throws(() => hs().finish(raw(h.hostEphPub), wrongHost.sign(th)), /verify/)
  assert.throws(() => hs().finish(raw(b64url(boxKey().pub)), raw(h.hs2Sig)), /verify/)
  // The pinned key is the one the computer id was made from.
  assert.equal(verify(hostPub, raw(h.hs2Sig), th), true)
  assert.equal(verify(hostPub, raw(h.hs2Sig), Buffer.alloc(32)), false)
})

test('frames match the vectors byte for byte, both directions', () => {
  const kD2H = raw(v.handshake.kD2H)
  const kH2D = raw(v.handshake.kH2D)
  for (const f of v.frames) {
    const key = f.dir === 'd2h' ? kD2H : kH2D
    assert.equal(sealFrame(key, f.c, f.final, Buffer.from(f.message)), f.d, `seal ${f.dir} ${f.c}`)
    const opened = openFrame(key, f.c, raw(f.d))
    assert.equal(opened.final, f.final)
    assert.equal(opened.chunk.toString(), f.message)
    assert.equal(b64url(Buffer.concat([Buffer.of(f.final ? 0 : 1), opened.chunk])), f.plaintext)
  }
})

test('a sealer and opener round trip with chunking, and refuse gaps, bad tags and oversize', () => {
  const key = raw(v.handshake.kD2H)
  const sealer = new FrameSealer(key)
  const big = Buffer.alloc(CHUNK * 2 + 10, 'x')
  const frames = sealer.seal(big)
  assert.equal(frames.length, 3)
  assert.deepEqual(frames.map((f) => f.c), [0, 1, 2])
  const opener = new FrameOpener(key)
  assert.equal(opener.open(0, raw(frames[0].d)), null)
  assert.equal(opener.open(1, raw(frames[1].d)), null)
  assert.deepEqual(opener.open(2, raw(frames[2].d)), big)

  // An empty message is one final frame.
  assert.equal(new FrameSealer(key).seal(Buffer.alloc(0)).length, 1)

  const next = sealer.seal(Buffer.from('hi'))
  assert.throws(() => new FrameOpener(key).open(5, raw(next[0].d)), /counter/)
  const tampered = Buffer.from(raw(next[0].d))
  tampered[2] ^= 1
  const o2 = new FrameOpener(key)
  // Counter 3 is `next`'s; open it at the right counter by catching up first.
  assert.throws(() => o2.open(0, tampered), /decrypt/)

  const small = new FrameOpener(key, 100)
  const fresh = new FrameSealer(key).seal(Buffer.alloc(200, 'y'))
  assert.throws(() => small.open(0, raw(fresh[0].d)), TooLarge)
})

test('SAS commit and code, and the pairing offer id', () => {
  const s = v.sas
  assert.equal(b64url(sasCommit(device.publicKey, raw(s.deviceNonce))), s.commit)
  assert.equal(sasCode(hostPub, device.publicKey, raw(s.deviceNonce), raw(s.hostNonce)), s.code)
  assert.equal(offerId(raw(v.pairing.code)), v.pairing.offerId)
})

test('the relay upgrade request signature matches the vector', () => {
  const r = v.requestSig
  const header = signatureHeader(device, {
    method: r.method, authority: r.authority, pathAndQuery: r.pathAndQuery, ts: r.ts, nonce: r.nonce,
  })
  assert.equal(`Kith-Sig: ${header}`, r.header)
})

test('strict base64url', () => {
  assert.equal(unb64url('AA+/'), null)
  assert.equal(unb64url('AAAAA'), null)
  assert.equal(unb64url('AAA='), null)
  assert.deepEqual(unb64url('AAA'), Buffer.alloc(2))
})
