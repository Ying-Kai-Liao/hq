import {
  Handshake, b64url, boxKey, cat, channelKeys, computerIdOf, offerId, openFrame, sasCode, sasCommit, sealFrame, signatureHeader, signerFromSeed, text,
  unb64url, verify, type Signer,
} from './crypto.ts'

/**
 * The byte-for-byte checks against serve/docs/reference/fixtures/remote-relay-vectors.json (the same file iOS's
 * RelayCrypto and the host's remote/crypto.rs are held to). They throw on the first difference and import nothing from
 * Node, so the same list runs under node:test (crypto.test.ts) and in a real browser (tools/browser-vectors).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vectors = any

class Mismatch extends Error {}

function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Mismatch(`${what}: got ${String(actual)}, expected ${String(expected)}`)
}

const raw = (s: string) => unb64url(s) as Uint8Array

/** Signs with the vectors' seed through the platform's own Ed25519, to prove an async signer matches. Optional. */
export type SignerFactory = (seed: Uint8Array) => Promise<Signer>

export const vectorChecks: Record<string, (v: Vectors, signerFrom: SignerFactory) => Promise<void> | void> = {
  'keys and the computer id': async (v, signerFrom) => {
    const device = await signerFrom(raw(v.keys.deviceSignSeed))
    eq(b64url(device.publicKey), v.keys.deviceSignPub, 'device sign pub')
    eq(b64url(signerFromSeed(raw(v.keys.hostSignSeed)).publicKey), v.keys.hostSignPub, 'host sign pub')
    eq(b64url(boxKey(raw(v.keys.hostBoxPriv)).pub), v.keys.hostBoxPub, 'host box pub')
    eq(computerIdOf(raw(v.keys.hostSignPub)), v.keys.computerId, 'computer id')
  },

  'handshake: hello, transcript hash, shared secret and channel keys': async (v, signerFrom) => {
    const h = v.handshake
    const device = await signerFrom(raw(v.keys.deviceSignSeed))
    const eph = boxKey(raw(h.deviceEphPriv))
    eq(b64url(eph.pub), h.deviceEphPub, 'device eph pub')
    const hs = new Handshake(device, raw(v.keys.hostSignPub), { eph, n: raw(h.n) })
    eq(b64url(hs.signInput), h.hs1SignInput, 'hs1 sign input')
    const hello = await hs.hello()
    eq(hello.sig, h.hs1Sig, 'hello sig')
    eq(Object.keys(hello).join(','), 't,v,dk,ek,n,sig', 'hello fields')
    eq((await hs.hello(true)).pair, true, 'pair flag')
    eq(b64url(boxKey(raw(h.hostEphPriv)).pub), h.hostEphPub, 'host eph pub')
    const keys = hs.finish(raw(h.hostEphPub), raw(h.hs2Sig)) as ReturnType<typeof channelKeys>
    eq(b64url(keys.ss), h.sharedSecret, 'shared secret')
    eq(b64url(keys.prk), h.prk, 'prk')
    eq(b64url(keys.d2h), h.kD2H, 'kD2H')
    eq(b64url(keys.h2d), h.kH2D, 'kH2D')
  },

  'a welcome signed by another key or over another transcript is refused': async (v, signerFrom) => {
    const h = v.handshake
    const device = await signerFrom(raw(v.keys.deviceSignSeed))
    const hostPub = raw(v.keys.hostSignPub)
    const make = () => new Handshake(device, hostPub, { eph: boxKey(raw(h.deviceEphPriv)), n: raw(h.n) })
    const th = raw(h.transcriptHash)
    const wrongSig = await signerFromSeed(new Uint8Array(32).fill(9)).sign(th)
    const refuses = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        if (/verify/.test(String((e as Error).message))) return
        throw e
      }
      throw new Mismatch('a bad welcome was accepted')
    }
    refuses(() => make().finish(raw(h.hostEphPub), wrongSig))
    refuses(() => make().finish(boxKey().pub, raw(h.hs2Sig)))
    eq(verify(hostPub, raw(h.hs2Sig), th), true, 'host signature over the transcript')
    eq(verify(hostPub, raw(h.hs2Sig), new Uint8Array(32)), false, 'host signature over another message')
  },

  'frames match byte for byte, both directions': (v) => {
    const kD2H = raw(v.handshake.kD2H)
    const kH2D = raw(v.handshake.kH2D)
    for (const f of v.frames) {
      const key = f.dir === 'd2h' ? kD2H : kH2D
      eq(sealFrame(key, f.c, f.final, text(f.message)), f.d, `seal ${f.dir} ${f.c}`)
      const opened = openFrame(key, f.c, raw(f.d))
      eq(opened.final, f.final, `final ${f.dir} ${f.c}`)
      eq(new TextDecoder().decode(opened.chunk), f.message, `open ${f.dir} ${f.c}`)
      eq(b64url(cat(Uint8Array.of(f.final ? 0 : 1), opened.chunk)), f.plaintext, `plaintext ${f.dir} ${f.c}`)
    }
  },

  'SAS commit and code, and the pairing offer id': async (v, signerFrom) => {
    const s = v.sas
    const device = await signerFrom(raw(v.keys.deviceSignSeed))
    eq(b64url(sasCommit(device.publicKey, raw(s.deviceNonce))), s.commit, 'commit')
    eq(sasCode(raw(v.keys.hostSignPub), device.publicKey, raw(s.deviceNonce), raw(s.hostNonce)), s.code, 'code')
    eq(offerId(raw(v.pairing.code)), v.pairing.offerId, 'offer id')
  },

  'the relay upgrade request signature matches': async (v, signerFrom) => {
    const r = v.requestSig
    const device = await signerFrom(raw(v.keys.deviceSignSeed))
    const header = await signatureHeader(device, { method: r.method, authority: r.authority, pathAndQuery: r.pathAndQuery, ts: r.ts, nonce: r.nonce })
    eq(`Kith-Sig: ${header}`, r.header, 'Kith-Sig header')
  },
}
