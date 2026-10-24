import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'

/**
 * The relay protocol's device-side cryptography (docs/reference/remote-relay.md §5, §6), shared by the desktop main
 * process and the web client. Pure JS (@noble) over Uint8Array: no node:crypto and no Buffer, so a browser bundles it.
 * The device identity is the one key kept outside this file, behind the async `Signer`, because a WebCrypto key can
 * only sign through a Promise. It speaks the `kith` label family and nothing older, and is checked byte for byte
 * against serve/docs/reference/fixtures/remote-relay-vectors.json (the iOS client's vectors too).
 */

// ---- encoding ----

// btoa/atob run natively and exist in Node 16+ and every browser; going through them in chunks keeps a 16 MiB message
// at tens of milliseconds, where a per-character JS loop blocked the Electron main process for most of a second.
const CHUNK_BYTES = 0x6000 // a multiple of 3, so every chunk but the last encodes without padding

export function b64url(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i += CHUNK_BYTES) {
    out += btoa(String.fromCharCode.apply(null, b.subarray(i, i + CHUNK_BYTES) as unknown as number[]))
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Strict base64url without padding, like the iOS client; null for anything else. */
export function unb64url(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const text = (s: string) => new TextEncoder().encode(s)
export const fromText = (b: Uint8Array) => new TextDecoder().decode(b)

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** `crypto.getRandomValues` exists in Node 20+ and in every browser. */
export const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n))

const u64be = (c: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(c))
  return out
}

export const sha256 = (...parts: Uint8Array[]): Uint8Array => nobleSha256(parts.length === 1 ? parts[0] : cat(...parts))

// ---- sizes (§6.3) ----

/** Largest plaintext chunk per frame. */
export const CHUNK = 256 * 1024
/** Reassembly limit for host to device messages. */
export const MAX_INBOUND = 16 * 1024 * 1024

// ---- label family: kith only ----

const label = (rest: string) => text(`kith/${rest}`)

// ---- keys ----

/**
 * An Ed25519 key that can sign: the desktop's per-account device key, the web's non-extractable WebCrypto key, or a
 * seed in tests. Signing is a Promise everywhere because WebCrypto can't do it synchronously.
 */
export interface Signer {
  /** The raw 32-byte public key. */
  publicKey: Uint8Array
  sign(message: Uint8Array): Promise<Uint8Array>
}

/** A signer over a raw seed, in pure JS (tests and tools; the desktop wraps its own key). */
export function signerFromSeed(seed: Uint8Array = randomBytes(32)): Signer {
  return { publicKey: ed25519.getPublicKey(seed), sign: async (m) => ed25519.sign(m, seed) }
}

/** Strict (RFC 8032) verification, like the Node and Rust implementations the vectors came from. */
export function verify(pub: Uint8Array, sig: Uint8Array, message: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, pub, { zip215: false })
  } catch {
    return false
  }
}

export interface BoxKey {
  priv: Uint8Array
  pub: Uint8Array
}

export function boxKey(priv: Uint8Array = randomBytes(32)): BoxKey {
  return { priv: Uint8Array.from(priv), pub: x25519.getPublicKey(priv) }
}

export class CryptoError extends Error {}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  let ss: Uint8Array
  try {
    ss = x25519.getSharedSecret(priv, pub)
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
export async function signatureHeader(
  signer: Signer,
  req: { method: string; authority: string; pathAndQuery: string; body?: Uint8Array; ts?: number; nonce?: string },
): Promise<string> {
  const ts = req.ts ?? Date.now()
  const nonce = req.nonce ?? b64url(randomBytes(16))
  const sig = await signer.sign(sigInput(req.method, req.authority, req.pathAndQuery, ts, nonce, req.body ?? new Uint8Array()))
  return `v=1,kid=${b64url(signer.publicKey)},ts=${ts},nonce=${nonce},sig=${b64url(sig)}`
}

// ---- handshake (§6.2) ----

export const hs1Input = (cid: Uint8Array, dk: Uint8Array, ekD: Uint8Array, n: Uint8Array) => cat(label('hs1/v1'), cid, dk, ekD, n)

export const transcriptHash = (cid: Uint8Array, dk: Uint8Array, ekD: Uint8Array, n: Uint8Array, ekH: Uint8Array) =>
  sha256(label('hs2/v1'), cid, dk, ekD, n, ekH)

export interface ChannelKeys {
  d2h: Uint8Array
  h2d: Uint8Array
}

const hmacSha256 = (key: Uint8Array, ...parts: Uint8Array[]) => hmac(nobleSha256, key, cat(...parts))

/** HKDF-SHA256: extract with the transcript hash as salt, expand one 32-byte block per direction. */
export function channelKeys(ekPriv: Uint8Array, peerEk: Uint8Array, th: Uint8Array): ChannelKeys & { ss: Uint8Array; prk: Uint8Array } {
  const ss = dh(ekPriv, peerEk)
  const prk = hmacSha256(th, ss)
  return {
    ss,
    prk,
    d2h: hmacSha256(prk, label('d2h/v1'), Uint8Array.of(1)),
    h2d: hmacSha256(prk, label('h2d/v1'), Uint8Array.of(1)),
  }
}

/** The device side of the handshake: `hello` out, then `finish(welcome)` verifies the pinned host and derives the keys. */
export class Handshake {
  readonly eph: BoxKey
  readonly n: Uint8Array
  private readonly cid: Uint8Array
  private readonly device: Signer
  private readonly hostSignPub: Uint8Array

  constructor(device: Signer, hostSignPub: Uint8Array, opts: { eph?: BoxKey; n?: Uint8Array } = {}) {
    this.device = device
    this.hostSignPub = hostSignPub
    this.eph = opts.eph ?? boxKey()
    this.n = Uint8Array.from(opts.n ?? randomBytes(32))
    this.cid = sha256(hostSignPub).subarray(0, 16)
  }

  get signInput() {
    return hs1Input(this.cid, this.device.publicKey, this.eph.pub, this.n)
  }

  async hello(pair = false): Promise<Record<string, unknown>> {
    return {
      t: 'hello',
      v: 1,
      dk: b64url(this.device.publicKey),
      ek: b64url(this.eph.pub),
      n: b64url(this.n),
      sig: b64url(await this.device.sign(this.signInput)),
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

const frameNonce = (c: number) => cat(new Uint8Array(4), u64be(c))
const frameAad = (c: number) => cat(label('frame/v1'), u64be(c))

export function sealFrame(key: Uint8Array, c: number, final: boolean, chunk: Uint8Array): string {
  return b64url(chacha20poly1305(key, frameNonce(c), frameAad(c)).encrypt(cat(Uint8Array.of(final ? 0 : 1), chunk)))
}

export function openFrame(key: Uint8Array, c: number, d: Uint8Array): { final: boolean; chunk: Uint8Array } {
  if (d.length < 17) throw new CryptoError('malformed frame')
  let plain: Uint8Array
  try {
    plain = chacha20poly1305(key, frameNonce(c), frameAad(c)).decrypt(d)
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
  private parts: Uint8Array[] = []
  private size = 0
  private readonly key: Uint8Array
  private readonly limit: number
  constructor(key: Uint8Array, limit = MAX_INBOUND) {
    this.key = key
    this.limit = limit
  }

  /** The whole message once its last chunk arrives, else null. Throws on a counter gap, a bad tag or too much data. */
  open(c: number, d: Uint8Array): Uint8Array | null {
    if (c !== this.counter) throw new CryptoError(`frame counter ${c}, expected ${this.counter}`)
    const { final, chunk } = openFrame(this.key, c, d)
    this.counter += 1
    if (this.size + chunk.length > this.limit) throw new TooLarge('message too large')
    this.parts.push(chunk)
    this.size += chunk.length
    if (!final) return null
    const whole = cat(...this.parts)
    this.parts = []
    this.size = 0
    return whole
  }
}

// ---- SAS (§4.2 B) ----

export const sasCommit = (deviceKey: Uint8Array, deviceNonce: Uint8Array) => sha256(label('sascommit/v1'), deviceKey, deviceNonce)

export function sasCode(hostSignPub: Uint8Array, deviceKey: Uint8Array, deviceNonce: Uint8Array, hostNonce: Uint8Array): string {
  const h = sha256(label('sas/v2'), hostSignPub, deviceKey, deviceNonce, hostNonce)
  return String(new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(0) % 1_000_000).padStart(6, '0')
}

/** A pairing link's one-time code to the id the relay knows it by (only for a pairing socket). */
export const offerId = (code: Uint8Array) => b64url(sha256(label('offer/v1'), code).subarray(0, 16))
