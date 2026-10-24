import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHUNK, FrameOpener, FrameSealer, b64url, boxKey, channelKeys, computerIdOf, hs1Input, signerFromSeed, transcriptHash, unb64url, verify,
} from './crypto.ts'
import { browserDial } from './dial.ts'
import { RelayLink, type DialAuth, type LinkState, type Socket } from './link.ts'

// A fake relay and a fake Mac: the Mac side is written from the protocol (§6.2) with the same primitives, so a
// mismatch with the device side shows up here. Byte-for-byte conformance is crypto.test.ts's job.

const hostKey = signerFromSeed(Buffer.alloc(32, 1))
const deviceKey = signerFromSeed(Buffer.alloc(32, 3))
const cid = computerIdOf(hostKey.publicKey)

// A real socket opens on a later turn than the dial call returns.
const soon = (f: () => void) => setTimeout(f, 0)
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, f: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = f()
    if (v) return v
    await tick(5)
  }
  throw new Error(`timed out: ${what}`)
}

/** One accepted socket as the Mac sees it. */
class Conn {
  readonly seen: Record<string, unknown>[] = []
  readonly inner: Record<string, unknown>[] = []
  codecs: { open: FrameOpener; seal: FrameSealer } | null = null
  closedWith: number | null = null
  readonly socket: Socket
  readonly url: string
  readonly auth: DialAuth
  private readonly relay: FakeRelay

  constructor(relay: FakeRelay, url: string, auth: DialAuth) {
    this.relay = relay
    this.url = url
    this.auth = auth
    this.socket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (text) => this.fromDevice(text),
      close: (code) => {
        this.closedWith = code
        soon(() => this.socket.onclose?.(code))
      },
    }
  }

  toDevice(m: unknown) {
    this.socket.onmessage?.(typeof m === 'string' ? m : JSON.stringify(m))
  }

  /** The relay closing the socket. */
  drop(code: number) {
    this.socket.onclose?.(code)
  }

  presence(online: boolean) {
    this.toDevice({ t: 'presence', online, lastSeenAt: online ? null : 1234 })
  }

  private fromDevice(text: string) {
    const m = JSON.parse(text) as Record<string, unknown>
    this.seen.push(m)
    if (m.t === 'hello') return void this.relay.onHello(this, m)
    if (m.t === 'f' && this.codecs) {
      const whole = this.codecs.open.open(m.c as number, unb64url(m.d as string)!)
      if (whole) {
        const inner = JSON.parse(Buffer.from(whole).toString('utf8')) as Record<string, unknown>
        this.inner.push(inner)
        this.relay.onInner(this, inner)
      }
    }
  }

  say(message: unknown) {
    for (const f of this.codecs!.seal.seal(Buffer.from(JSON.stringify(message)))) this.toDevice({ t: 'f', c: f.c, d: f.d })
  }
}

class FakeRelay {
  readonly conns: Conn[] = []
  signer = hostKey
  onInner: (c: Conn, inner: Record<string, unknown>) => void = (c, inner) => {
    if (typeof inner.m === 'string') c.say({ id: inner.id, ok: { echoed: inner.m, b: inner.b } })
  }
  /** Which Mac answers the handshake; a different key plays an impostor. */
  autoOnline = true

  dial = (url: string, auth: DialAuth): Socket => {
    const c = new Conn(this, url, auth)
    this.conns.push(c)
    soon(() => {
      c.socket.onopen?.()
      if (this.autoOnline) c.presence(true)
    })
    return c.socket
  }

  async onHello(c: Conn, hello: Record<string, unknown>) {
    const dk = unb64url(hello.dk as string)!
    const ekD = unb64url(hello.ek as string)!
    const n = unb64url(hello.n as string)!
    assert.equal(verify(dk, unb64url(hello.sig as string)!, hs1Input(unb64url(cid)!, dk, ekD, n)), true, 'hello signature')
    const eph = boxKey()
    const th = transcriptHash(unb64url(cid)!, dk, ekD, n, eph.pub)
    const keys = channelKeys(eph.priv, ekD, th)
    c.codecs = { open: new FrameOpener(keys.d2h), seal: new FrameSealer(keys.h2d) }
    c.toDevice({ t: 'welcome', v: 1, ek: b64url(eph.pub), sig: b64url(await this.signer.sign(th)) })
  }
}

function link(relay: FakeRelay, over: { hostSignKey?: string; computerId?: string } = {}) {
  return new RelayLink({
    cloudURL: 'http://cloud.test:8787',
    computerId: over.computerId ?? cid,
    hostSignKey: over.hostSignKey ?? b64url(hostKey.publicKey),
    signer: deviceKey,
    dial: relay.dial,
    probe: async () => null,
    delay: () => 5,
  })
}

test('connects over the relay with a signed upgrade, handshakes and answers a call', async () => {
  const relay = new FakeRelay()
  const l = link(relay)
  assert.deepEqual(await l.call('hello', {}, 2000), { echoed: 'hello', b: {} })
  const c = relay.conns[0]
  assert.equal(c.url, `ws://cloud.test:8787/v1/relay/device/${cid}?v=1`)
  const sig = c.auth.sig
  assert.match(sig, /^v=1,kid=[\w-]+,ts=\d+,nonce=[\w-]+,sig=[\w-]+$/)
  assert.equal(sig.split(',')[1], `kid=${b64url(deviceKey.publicKey)}`)
  assert.equal(l.state.kind, 'ready')
  l.close()
})

test('two calls at once share the one connection', async () => {
  const relay = new FakeRelay()
  const l = link(relay)
  const [a, b] = await Promise.all([l.call('one', null, 2000), l.call('two', null, 2000)])
  assert.equal((a as { echoed: string }).echoed, 'one')
  assert.equal((b as { echoed: string }).echoed, 'two')
  assert.equal(relay.conns.length, 1)
  l.close()
})

test("a host's error comes back unchanged, status and words", async () => {
  const relay = new FakeRelay()
  relay.onInner = (c, inner) => c.say({ id: inner.id, err: { status: 403, message: 'Prove your invite first.' } })
  const l = link(relay)
  await assert.rejects(l.call('send', {}, 2000), (e: { status: number; message: string }) => e.status === 403 && e.message === 'Prove your invite first.')
  l.close()
})

test('a message over 256 KiB leaves in chunks and the Mac reassembles it', async () => {
  const relay = new FakeRelay()
  const l = link(relay)
  const big = 'x'.repeat(CHUNK * 2 + 5)
  const res = (await l.call('upload', { data: big }, 5000)) as { b: { data: string } }
  assert.equal(res.b.data.length, big.length)
  const frames = relay.conns[0].seen.filter((m) => m.t === 'f')
  assert.ok(frames.length >= 3)
  assert.deepEqual(frames.map((f) => f.c), frames.map((_, i) => i))
  l.close()
})

test('a welcome from another key is refused for good: no calls, no second dial', async () => {
  const relay = new FakeRelay()
  relay.signer = signerFromSeed(Buffer.alloc(32, 9))
  const l = link(relay)
  await assert.rejects(l.call('hello', {}, 2000), (e: { code: string; message: string }) => e.code === 'identityChanged' && /identity changed/.test(e.message))
  await tick(60)
  assert.equal(relay.conns.length, 1)
  assert.equal(l.state.kind, 'failed')
  await assert.rejects(l.call('hello', {}, 200), (e: { code: string }) => e.code === 'identityChanged')
  l.close()
})

test("a sign key that doesn't match the computer id is never dialled", async () => {
  const relay = new FakeRelay()
  const l = link(relay, { computerId: computerIdOf(Buffer.alloc(32, 7)) })
  await assert.rejects(l.call('hello', {}, 200), (e: { code: string }) => e.code === 'badSignKey')
  assert.equal(relay.conns.length, 0)
})

test('host offline is said plainly, and the channel comes back when the host does, on the same socket', async () => {
  const relay = new FakeRelay()
  const l = link(relay)
  await l.call('hello', {}, 2000)
  relay.conns[0].presence(false)
  await assert.rejects(l.call('hello', {}, 500), (e: { code: string; status: number }) => e.code === 'hostOffline' && e.status === 0)
  assert.equal(l.state.kind, 'hostOffline')
  relay.conns[0].presence(true)
  assert.deepEqual(((await l.call('again', null, 2000)) as { echoed: string }).echoed, 'again')
  assert.equal(relay.conns.length, 1)
  l.close()
})

test('a call in flight when the host goes offline fails as offline', async () => {
  const relay = new FakeRelay()
  relay.onInner = () => {}
  const l = link(relay)
  const states: string[] = []
  l.onState((s: LinkState) => states.push(s.kind))
  const pending = l.call('slow', {}, 5000)
  await until('call sent', () => relay.conns[0]?.inner.length)
  relay.conns[0].presence(false)
  await assert.rejects(pending, (e: { code: string }) => e.code === 'hostOffline')
  assert.ok(states.includes('hostOffline'))
  l.close()
})

test('a revoked grant (close 4003) says access removed and stops redialling', async () => {
  const relay = new FakeRelay()
  const l = link(relay)
  await l.call('hello', {}, 2000)
  relay.conns[0].drop(4003)
  await until('unauthorized', () => l.state.kind === 'unauthorized')
  await assert.rejects(l.call('hello', {}, 200), (e: { code: string; status: number; message: string }) => e.code === 'accessRemoved' && e.status === 401 && /removed/.test(e.message))
  await tick(60)
  assert.equal(relay.conns.length, 1)
  // Once access is granted again the caller restarts it.
  l.restart()
  assert.equal(((await l.call('back', null, 2000)) as { echoed: string }).echoed, 'back')
  assert.equal(relay.conns.length, 2)
  l.close()
})

test('a plain drop reconnects with backoff and a fresh handshake', async () => {
  const relay = new FakeRelay()
  const l = link(relay)
  await l.call('hello', {}, 2000)
  relay.conns[0].drop(1006)
  assert.equal(((await l.call('after', null, 3000)) as { echoed: string }).echoed, 'after')
  assert.equal(relay.conns.length, 2)
  l.close()
})

test('a socket that never opens is retried, not given up on', async () => {
  const relay = new FakeRelay()
  let n = 0
  const dial = (url: string, auth: DialAuth): Socket => {
    if (n++ < 2) {
      const s: Socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null }
      soon(() => s.onclose?.(1006))
      return s
    }
    return relay.dial(url, auth)
  }
  const l = new RelayLink({ cloudURL: 'https://cloud.test', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: deviceKey, dial, probe: async () => null, delay: () => 5 })
  assert.equal(((await l.call('x', null, 3000)) as { echoed: string }).echoed, 'x')
  assert.equal(n, 3)
  l.close()
})

for (const [status, message, code] of [
  [426, /too old/, 426],
  [404, /isn't on your account/, 404],
] as const) {
  test(`a refused upgrade the relay answers ${status} to is a final, specific refusal`, async () => {
    const dial = (): Socket => {
      const s: Socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null }
      soon(() => s.onclose?.(1006))
      return s
    }
    const l = new RelayLink({ cloudURL: 'https://cloud.test', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: deviceKey, dial, probe: async () => status, delay: () => 5 })
    l.start()
    await until('failed', () => l.state.kind === 'failed')
    assert.match((l.state as { message: string }).message, message)
    await assert.rejects(l.call('hello', {}, 100), (e: { status: number }) => e.status === code)
    l.close()
  })
}

test('a refused upgrade the probe cannot explain stays unreachable and retries', async () => {
  const dial = (): Socket => {
    const s: Socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null }
    soon(() => s.onclose?.(1006))
    return s
  }
  const l = new RelayLink({ cloudURL: 'https://cloud.test', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: deviceKey, dial, probe: async () => 502, delay: () => 5 })
  l.start()
  try {
    await assert.rejects(l.call('x', null, 150), (e: { status: number }) => e.status === 0)
    // A retrying failure shows as a non-final `failed` between attempts; only a final one is a verdict.
    const s = l.state
    assert.ok(!(s.kind === 'failed' && s.final), 'a refusal nobody can explain is not final')
  } finally {
    l.close()
  }
})

test('an event stream delivers each event as JSON, and cancel and end are told to the Mac and the caller', async () => {
  const relay = new FakeRelay()
  relay.onInner = (c, inner) => {
    if (inner.sub === 'events') {
      c.say({ id: inner.id, ev: { type: 'hello', rev: 1 } })
      c.say({ id: inner.id, ev: { type: 'resync' } })
    }
  }
  const l = link(relay)
  const lines: string[] = []
  let ended: unknown = 'not yet'
  const cancel = l.subscribe('events', { since: 0, client: 'desktop' }, (line) => lines.push(line), (e) => (ended = e))
  await until('two events', () => lines.length === 2)
  assert.deepEqual(lines.map((x) => JSON.parse(x).type), ['hello', 'resync'])
  assert.deepEqual(relay.conns[0].inner[0].b, { since: 0, client: 'desktop' })
  cancel()
  const id = relay.conns[0].inner[0].id
  await until('cancel sent', () => relay.conns[0].inner.some((m) => m.id === id && m.cancel === true))
  assert.equal(ended, 'not yet')

  const l2 = link(relay)
  let end2: unknown = 'not yet'
  l2.subscribe('events', {}, () => {}, (e) => (end2 = e))
  const c2 = await until('second link', () => relay.conns[1])
  await until('sub', () => c2.inner.length)
  c2.say({ id: c2.inner[0].id, end: true })
  await until('ended', () => end2 === null)
  l.close()
  l2.close()
})

test('a stream is ended with an error when the channel drops, so the store resubscribes', async () => {
  const relay = new FakeRelay()
  relay.onInner = () => {}
  const l = link(relay)
  let ended: { status: number } | null | 'no' = 'no'
  l.subscribe('events', {}, () => {}, (e) => (ended = e))
  await until('sub sent', () => relay.conns[0]?.inner.length)
  relay.conns[0].drop(1006)
  await until('ended', () => ended !== 'no')
  assert.equal((ended as unknown as { status: number }).status, 0)
  l.close()
})

test('a call that gets no answer times out as unreachable', async () => {
  const relay = new FakeRelay()
  relay.onInner = () => {}
  const l = link(relay)
  await assert.rejects(l.call('hello', {}, 100), (e: { status: number }) => e.status === 0)
  l.close()
})

test('an old host (reject unsupportedVersion) is a final, plain refusal', async () => {
  const relay = new FakeRelay()
  relay.autoOnline = false
  const l = link(relay)
  l.start()
  const c = await until('dialled', () => relay.conns[0])
  c.toDevice({ t: 'reject', code: 'unsupportedVersion' })
  await until('failed', () => l.state.kind === 'failed')
  await assert.rejects(l.call('hello', {}, 100), (e: { status: number }) => e.status === 426)
  l.close()
})

// ---- close codes a browser gets for a refused upgrade (design §4.6), and the browser dialer ----

for (const [closeCode, kind, code, status] of [
  [4404, 'failed', 'unknownComputer', 404],
  [4426, 'failed', 'upgrade', 426],
  [4401, 'failed', 'signedOut', 401],
  [4403, 'unauthorized', undefined, 401],
] as const) {
  test(`close ${closeCode} is a final answer, not a redial`, async () => {
    const relay = new FakeRelay()
    const l = link(relay)
    await l.call('hello', {}, 2000)
    relay.conns[0].drop(closeCode)
    await until('stopped', () => l.state.kind === kind)
    if (kind === 'failed') assert.equal((l.state as { code: string }).code, code)
    await assert.rejects(l.call('hello', {}, 100), (e: { status: number }) => e.status === status)
    await tick(60)
    assert.equal(relay.conns.length, 1)
    l.close()
  })
}

test('close 4100 dials again at once, with a new signature each time', async () => {
  const relay = new FakeRelay()
  const sigs: string[] = []
  const l = new RelayLink({
    cloudURL: 'http://cloud.test:8787', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: deviceKey, delay: () => 5,
    dial: (url, auth) => {
      sigs.push(auth.sig)
      return relay.dial(url, auth)
    },
  })
  await l.call('hello', {}, 2000)
  relay.conns[0].drop(4100)
  assert.equal(((await l.call('again', null, 2000)) as { echoed: string }).echoed, 'again')
  assert.equal(relay.conns.length, 2)
  assert.equal(new Set(sigs.map((s) => s.split('nonce=')[1])).size, 2, 'a new nonce per dial')
  l.close()
})

/** A WebSocket-shaped object over a FakeRelay connection, remembering the subprotocols it was opened with. */
function fakeWebSocket(relay: FakeRelay) {
  return class {
    constructor(url: string, protocols: string[]) {
      const listeners: Record<string, ((e: never) => void)[]> = {}
      const socket = relay.dial(url, { sig: 'browser' })
      ;(relay.conns[relay.conns.length - 1] as unknown as { protocols: string[] }).protocols = protocols
      socket.onopen = () => listeners.open?.forEach((f) => f(undefined as never))
      socket.onmessage = (data) => listeners.message?.forEach((f) => f({ data } as never))
      socket.onclose = (code) => listeners.close?.forEach((f) => f({ code } as never))
      return {
        send: (t: string) => socket.send(t),
        close: (c?: number) => socket.close(c ?? 1000),
        addEventListener: (type: string, cb: (e: never) => void) => (listeners[type] ??= []).push(cb),
      } as never
    }
  } as never
}

test('a dial that says signed out stops the link until it is restarted', async () => {
  const relay = new FakeRelay()
  let signedIn = false
  const l = new RelayLink({
    cloudURL: 'http://cloud.test:8787', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: deviceKey, delay: () => 5,
    dial: browserDial({
      jwt: async () => {
        if (!signedIn) throw new Error('no session')
        return 'jwt.fresh.token'
      },
      WebSocket: fakeWebSocket(relay),
    }),
  })
  await assert.rejects(l.call('hello', {}, 500), (e: { code: string; status: number }) => e.code === 'signedOut' && e.status === 401)
  assert.equal(relay.conns.length, 0)
  signedIn = true
  l.restart()
  assert.equal(((await l.call('in', null, 2000)) as { echoed: string }).echoed, 'in')
  l.close()
})

test('the browser dialer carries kith.v1, the signature and a fresh JWT as subprotocols', async () => {
  const relay = new FakeRelay()
  let n = 0
  const l = new RelayLink({
    cloudURL: 'http://cloud.test:8787', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: deviceKey, delay: () => 5,
    dial: browserDial({ jwt: async () => `jwt.n${++n}.x`, WebSocket: fakeWebSocket(relay) }),
  })
  await l.call('hello', {}, 2000)
  relay.conns[0].drop(4100)
  await l.call('again', null, 2000)
  const protos = relay.conns.map((c) => (c as unknown as { protocols: string[] }).protocols)
  assert.equal(protos.length, 2)
  for (const [i, p] of protos.entries()) {
    assert.equal(p.length, 3)
    assert.equal(p[0], 'kith.v1')
    assert.match(p[1], /^kith-sig\.[\w-]+$/)
    assert.equal(p[2], `kith-jwt.jwt.n${i + 1}.x`)
    // The signature rides as the same Kith-Sig header value a desktop would send.
    const header = Buffer.from(p[1].slice('kith-sig.'.length), 'base64url').toString()
    assert.match(header, /^v=1,kid=[\w-]+,ts=\d+,nonce=[\w-]+,sig=[\w-]+$/)
    assert.equal(header.split(',')[1], `kid=${b64url(deviceKey.publicKey)}`)
  }
  l.close()
})

test('a newer presence supersedes a hello still being signed: only the latest handshake is sent', async () => {
  const relay = new FakeRelay()
  relay.autoOnline = false
  const pending: (() => void)[] = []
  const slow = {
    publicKey: deviceKey.publicKey,
    sign: (m: Uint8Array) => new Promise<Uint8Array>((resolve) => pending.push(() => void deviceKey.sign(m).then(resolve))),
  }
  const l = new RelayLink({ cloudURL: 'http://cloud.test:8787', computerId: cid, hostSignKey: b64url(hostKey.publicKey), signer: slow, dial: relay.dial, delay: () => 5 })
  l.start()
  // The upgrade itself is signed first.
  await until('upgrade signing', () => pending.length)
  pending.shift()!()
  const c = await until('dialled', () => relay.conns[0])
  await until('opened', () => c.socket.onmessage)
  c.presence(true)
  c.presence(true)
  await until('both hellos signing', () => pending.length === 2)
  for (const release of pending.splice(0)) release()
  await tick(40)
  assert.equal(c.seen.filter((m) => m.t === 'hello').length, 1, 'the stale hello was dropped')
  await until('ready', () => l.state.kind === 'ready')
  l.close()
})
