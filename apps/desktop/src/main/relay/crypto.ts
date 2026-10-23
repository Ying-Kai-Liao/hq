import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes,
  sign as edSign, verify as edVerify,
} from 'node:crypto'

/**
 * The relay protocol's device-side cryptography (docs/reference/remote-relay.md §5, §6): Node's built-in
 * Ed25519, X25519, HKDF-SHA256 and ChaCha20-Poly1305 only. It speaks the `kith` label family and nothing older, and is
 * checked byte for byte against serve/docs/reference/fixtures/remote-relay-vectors.json (the iOS client's vectors too).
 * No electron imports, so node's test runner loads it.
 */

// ---- encoding ----

export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

/** Strict base64url without padding, like the iOS client; null for anything else. */
export function unb64url(s: string): Buffer | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  return Buffer.from(s, 'base64url')
}

const u64be = (c: number) => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(c))
  return out
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

const text = (s: string) => Buffer.from(s, 'utf8')
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts)

// ---- sizes (§6.3) ----

/** Largest plaintext chunk per frame. */
export const CHUNK = 256 * 1024
/** Reassembly limit for host to device messages. */
export const MAX_INBOUND = 16 * 1024 * 1024

// ---- label family: kith only ----

const label = (rest: string) => text(`kith/${rest}`)

// ---- keys ----

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex')

/** An Ed25519 key that can sign: the desktop's per-account device key, or a seed in tests. */
export interface Signer {
  /** The raw 32-byte public key. */
  publicKey: Buffer
  sign(message: Uint8Array): Buffer
}

export function signerFromSeed(seed: Uint8Array = randomBytes(32)): Signer {
  const key = createPrivateKey({ key: cat(ED_PKCS8, seed), format: 'der', type: 'pkcs8' })
  const publicKey = Buffer.from(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32))
  return { publicKey, sign: (m) => edSign(null, m, key) }
}

export function verify(pub: Uint8Array, sig: Uint8Array, message: Uint8Array): boolean {
  try {
    return edVerify(null, message, createPublicKey({ key: cat(ED_SPKI, pub), format: 'der', type: 'spki' }), sig)
  } catch {
    return false
  }
}

export interface BoxKey {
  priv: Buffer
  pub: Buffer
}

export function boxKey(priv: Uint8Array = randomBytes(32)): BoxKey {
  const key = createPrivateKey({ key: cat(X_PKCS8, priv), format: 'der', type: 'pkcs8' })
  return { priv: Buffer.from(priv), pub: Buffer.from(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)) }
}

export class CryptoError extends Error {}

function dh(priv: Uint8Array, pub: Uint8Array): Buffer {
  let ss: Buffer
  try {
    ss = diffieHellman({
      privateKey: createPrivateKey({ key: cat(X_PKCS8, priv), format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: cat(X_SPKI, pub), format: 'der', type: 'spki' }),
    })
  } catch {
    throw new CryptoError('bad key agreement')
  }
  if (ss.every((b) => b === 0)) throw new CryptoError('all-zero shared secret')
  return ss
}

/** A computer's id: the first 16 bytes of sha256 of its sign key. */
export const computerIdOf = (hostSignPub: Uint8Array) => b64url(sha256(hostSignPub).subarray(0, 16))

// ---- Kith-Sig (§5) ----

export function sigInput(method: string, authority: string, pathAndQuery: string, ts: number, nonce: string, body: Uint8Array) {
  return text(['kith-sig-v1', method.toUpperCase(), authority.toLowerCase(), pathAndQuery, String(ts), nonce, b64url(sha256(body))].join('\n'))
}

/** The `Kith-Sig` header value. */
export function signatureHeader(
  signer: Signer,
  req: { method: string; authority: string; pathAndQuery: string; body?: Uint8Array; ts?: number; nonce?: string },
): string {
  const ts = req.ts ?? Date.now()
  const nonce = req.nonce ?? b64url(randomBytes(16))
  const sig = signer.sign(sigInput(req.method, req.authority, req.pathAndQuery, ts, nonce, req.body ?? new Uint8Array()))
  return `v=1,kid=${b64url(signer.publicKey)},ts=${ts},nonce=${nonce},sig=${b64url(sig)}`
}

// ---- handshake (§6.2) ----

export const hs1Input = (cid: Uint8Array, dk: Uint8Array, ekD: Uint8Array, n: Uint8Array) => cat(label('hs1/v1'), cid, dk, ekD, n)

export const transcriptHash = (cid: Uint8Array, dk: Uint8Array, ekD: Uint8Array, n: Uint8Array, ekH: Uint8Array) =>
  sha256(label('hs2/v1'), cid, dk, ekD, n, ekH)

export interface ChannelKeys {
  d2h: Buffer
  h2d: Buffer
}

const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const h = createHmac('sha256', key)
  for (const p of parts) h.update(p)
  return h.digest()
}

/** HKDF-SHA256: extract with the transcript hash as salt, expand one 32-byte block per direction. */
export function channelKeys(ekPriv: Uint8Array, peerEk: Uint8Array, th: Uint8Array): ChannelKeys & { ss: Buffer; prk: Buffer } {
  const ss = dh(ekPriv, peerEk)
  const prk = hmac(th, ss)
  return {
    ss,
    prk,
    d2h: hmac(prk, label('d2h/v1'), Buffer.of(1)),
    h2d: hmac(prk, label('h2d/v1'), Buffer.of(1)),
  }
}

/** The device side of the handshake: `hello` out, then `finish(welcome)` verifies the pinned host and derives the keys. */
export class Handshake {
  readonly eph: BoxKey
  readonly n: Buffer
  private readonly cid: Buffer
  private readonly device: Signer
  private readonly hostSignPub: Uint8Array

  constructor(device: Signer, hostSignPub: Uint8Array, opts: { eph?: BoxKey; n?: Uint8Array } = {}) {
    this.device = device
    this.hostSignPub = hostSignPub
    this.eph = opts.eph ?? boxKey()
    this.n = Buffer.from(opts.n ?? randomBytes(32))
    this.cid = sha256(hostSignPub).subarray(0, 16)
  }

  get signInput() {
    return hs1Input(this.cid, this.device.publicKey, this.eph.pub, this.n)
  }

  hello(pair = false): Record<string, unknown> {
    return {
      t: 'hello',
      v: 1,
      dk: b64url(this.device.publicKey),
      ek: b64url(this.eph.pub),
      n: b64url(this.n),
      sig: b64url(this.device.sign(this.signInput)),
      ...(pair ? { pair: true } : {}),
    }
  }

  /** Throws unless the pinned host key signed the transcript. */
  finish(ekH: Uint8Array, sig: Uint8Array): ChannelKeys {
    if (ekH.length !== 32) throw new CryptoError('bad host key')
    const th = transcriptHash(this.cid, this.device.publicKey, this.eph.pub, this.n, ekH)
    if (!verify(this.hostSignPub, sig, th)) throw new CryptoError("welcome signature doesn't verify")
    return channelKeys(this.eph.priv, ekH, th)
  }
}

// ---- frames (§6.3) ----

const frameNonce = (c: number) => cat(Buffer.alloc(4), u64be(c))
const frameAad = (c: number) => cat(label('frame/v1'), u64be(c))

export function sealFrame(key: Uint8Array, c: number, final: boolean, chunk: Uint8Array): string {
  const cipher = createCipheriv('chacha20-poly1305', key, frameNonce(c), { authTagLength: 16 })
  cipher.setAAD(frameAad(c), { plaintextLength: chunk.length + 1 })
  return b64url(cat(cipher.update(cat(Buffer.of(final ? 0 : 1), chunk)), cipher.final(), cipher.getAuthTag()))
}

export function openFrame(key: Uint8Array, c: number, d: Uint8Array): { final: boolean; chunk: Buffer } {
  if (d.length < 17) throw new CryptoError('malformed frame')
  let plain: Buffer
  try {
    const decipher = createDecipheriv('chacha20-poly1305', key, frameNonce(c), { authTagLength: 16 })
    decipher.setAAD(frameAad(c), { plaintextLength: d.length - 16 })
    decipher.setAuthTag(Buffer.from(d.subarray(d.length - 16)))
    plain = cat(decipher.update(d.subarray(0, d.length - 16)), decipher.final())
  } catch {
    throw new CryptoError('frame failed to decrypt')
  }
  if (plain[0] !== 0 && plain[0] !== 1) throw new CryptoError('bad frame flag')
  return { final: plain[0] === 0, chunk: plain.subarray(1) }
}

export class TooLarge extends CryptoError {}

/** One direction's sender: every message becomes chunks of at most 256 KiB with consecutive counters. */
export class FrameSealer {
  private counter = 0
  private readonly key: Uint8Array
  constructor(key: Uint8Array) {
    this.key = key
  }

  /** Past 2^32 frames the channel must be replaced (close 4011). */
  get exhausted() {
    return this.counter >= 2 ** 32
  }

  seal(message: Uint8Array): { c: number; d: string }[] {
    const out: { c: number; d: string }[] = []
    let at = 0
    do {
      const chunk = message.subarray(at, at + CHUNK)
      at += chunk.length
      out.push({ c: this.counter, d: sealFrame(this.key, this.counter, at >= message.length, chunk) })
      this.counter += 1
    } while (at < message.length)
    return out
  }
}

/** One direction's receiver: demands the exact next counter and reassembles chunks up to the inbound limit. */
export class FrameOpener {
  private counter = 0
  private parts: Buffer[] = []
  private size = 0
  private readonly key: Uint8Array
  private readonly limit: number
  constructor(key: Uint8Array, limit = MAX_INBOUND) {
    this.key = key
    this.limit = limit
  }

  /** The whole message once its last chunk arrives, else null. Throws on a counter gap, a bad tag or too much data. */
  open(c: number, d: Uint8Array): Buffer | null {
    if (c !== this.counter) throw new CryptoError(`frame counter ${c}, expected ${this.counter}`)
    const { final, chunk } = openFrame(this.key, c, d)
    this.counter += 1
    if (this.size + chunk.length > this.limit) throw new TooLarge('message too large')
    this.parts.push(chunk)
    this.size += chunk.length
    if (!final) return null
    const whole = Buffer.concat(this.parts)
    this.parts = []
    this.size = 0
    return whole
  }
}

// ---- SAS (§4.2 B) ----

export const sasCommit = (deviceKey: Uint8Array, deviceNonce: Uint8Array) => sha256(label('sascommit/v1'), deviceKey, deviceNonce)

export function sasCode(hostSignPub: Uint8Array, deviceKey: Uint8Array, deviceNonce: Uint8Array, hostNonce: Uint8Array): string {
  const h = sha256(label('sas/v2'), hostSignPub, deviceKey, deviceNonce, hostNonce)
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** A pairing link's one-time code to the id the relay knows it by (only for a pairing socket). */
export const offerId = (code: Uint8Array) => b64url(sha256(label('offer/v1'), code).subarray(0, 16))
