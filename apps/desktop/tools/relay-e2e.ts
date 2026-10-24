// The desktop relay client against the real cloud: `wrangler dev --env local` (serve/cloud) with a fake Mac that speaks
// the host side of the relay protocol. A second device of the owner's account registers, asks for access (commit,
// reveal, six digits the Mac checks), is approved, and then reaches the Mac over the relay end to end with the same
// RelayLink the app uses: `hello`, an event stream, a host refusal passed up unchanged, and "access removed" when the
// Mac's ACL drops the device.
//
//   npm --prefix serve/cloud ci      (once; wrangler)
//   node --experimental-strip-types tools/relay-e2e.ts
//
// A temporary wrangler state under KITH_E2E_CACHE (default "/Volumes/Macos 1TB/.cache"); no real kith-serve and no ~/.kith.
// Heavy for a laptop (workerd): run it through the flow test_slot at background priority.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestAccess } from '../src/main/relay/access.ts'
import {
  FrameOpener, FrameSealer, b64url, boxKey, channelKeys, computerIdOf, hs1Input, sasCode, signatureHeader, signerFromSeed, transcriptHash, unb64url, verify,
  type Signer,
} from '../src/main/relay/crypto.ts'
import { dialWebSocket, RelayLink, type Socket } from '../src/main/relay/link.ts'

const CLOUD_DIR = fileURLToPath(new URL('../../../serve/cloud', import.meta.url))
const PORT = Number(process.env.KITH_E2E_RELAY_PORT ?? 8791)
const CLOUD = `http://127.0.0.1:${PORT}`
const ISSUER = 'https://clerk.test.local' // [env.local] CLERK_ISSUER
const WRANGLER = join(CLOUD_DIR, 'node_modules/.bin/wrangler')
const base = process.env.KITH_E2E_CACHE ?? '/Volumes/Macos 1TB/.cache'
mkdirSync(existsSync(base) ? base : tmpdir(), { recursive: true })
const tmp = mkdtempSync(join(existsSync(base) ? base : tmpdir(), 'kith-desktop-relay-e2e-'))
const persist = join(tmp, 'wrangler')
const children: ChildProcess[] = []

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`)
  console.log(`  ok ${what}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v as T
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(5000)])
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
}

// A self-signed Clerk session: the local cloud trusts CLERK_JWT_KEY.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwtKey = publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/-----[A-Z ]+-----|\s/g, '')
async function clerkToken(sub: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateKey.export({ format: 'jwk' }), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const now = Math.floor(Date.now() / 1000)
  const part = (v: unknown) => b64url(Buffer.from(JSON.stringify(v)))
  const head = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: ISSUER, sub, sid: `sess_${sub}`, iat: now - 5, nbf: now - 5, exp: now + 3600, email: `${sub}@example.com` })}`
  return `${head}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(head))))}`
}

async function cloud(method: string, path: string, o: { token?: string; signer?: Signer; body?: unknown } = {}) {
  const bytes = o.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(o.body))
  const headers: Record<string, string> = {}
  if (o.token) headers.Authorization = `Bearer ${o.token}`
  if (o.body !== undefined) headers['Content-Type'] = 'application/json'
  if (o.signer) headers['Kith-Sig'] = signatureHeader(o.signer, { method, authority: `127.0.0.1:${PORT}`, pathAndQuery: path, body: bytes })
  const res = await fetch(CLOUD + path, { method, headers, body: bytes.length ? bytes : undefined })
  return { status: res.status, body: (await res.json()) as any }
}

// ---- the fake Mac (host side of §6, §7) ----

class FakeMac {
  readonly sign = signerFromSeed(Buffer.alloc(32, 0x51)) // obviously fake, low entropy
  readonly box = boxKey(Buffer.alloc(32, 0x52))
  readonly computerId = computerIdOf(this.sign.publicKey)
  private ws: Socket | null = null
  private aclVer = 0
  private readonly links = new Map<string, { dk: Buffer; open: FrameOpener | null; seal: FrameSealer | null }>()
  readonly calls: string[] = []
  refuse = false
  /** Fire an event on every open events subscription. */
  readonly subs = new Map<string, number>()

  async register() {
    return cloud('POST', '/v1/host/register', {
      signer: this.sign,
      body: { boxKey: b64url(this.box.pub), name: 'Test Mac', platform: 'macos', device: 'e2e', version: '0.1.0' },
    })
  }

  async connect(devices: { dk: string; grant: string | null }[]) {
    this.close()
    const url = `${CLOUD.replace('http', 'ws')}/v1/relay/host?v=1`
    const header = signatureHeader(this.sign, { method: 'GET', authority: `127.0.0.1:${PORT}`, pathAndQuery: '/v1/relay/host?v=1' })
    const ws = dialWebSocket(url, { 'Kith-Sig': header })
    this.ws = ws
    const acked = new Promise<void>((resolve) => {
      ws.onmessage = (text) => {
        const m = JSON.parse(text)
        if (m.t === 'acl.ok') resolve()
        else if (m.t === 'open') this.links.set(m.link, { dk: unb64url(m.dk)!, open: null, seal: null })
        else if (m.t === 'data') this.onData(m.link, m.m)
      }
    })
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
    this.sendAcl(devices)
    await acked
    ws.send(JSON.stringify({ t: 'ready' }))
  }

  sendAcl(devices: { dk: string; grant: string | null }[]) {
    this.aclVer += 1
    const bytes = Buffer.from(JSON.stringify({ v: 1, computerId: this.computerId, ver: this.aclVer, devices, offers: [] }))
    this.ws!.send(JSON.stringify({ t: 'acl', d: b64url(bytes), sig: b64url(this.sign.sign(bytes)) }))
  }

  close() {
    this.ws?.close(1000)
    this.ws = null
  }

  private to(link: string, m: unknown) {
    this.ws!.send(JSON.stringify({ t: 'data', link, m }))
  }

  private say(link: string, message: unknown) {
    const l = this.links.get(link)!
    for (const f of l.seal!.seal(Buffer.from(JSON.stringify(message)))) this.to(link, { t: 'f', c: f.c, d: f.d })
  }

  event(ev: unknown) {
    for (const [link, id] of this.subs) this.say(link, { id, ev })
  }

  private onData(link: string, m: any) {
    const l = this.links.get(link)
    if (!l) return
    if (m.t === 'hello') {
      const dk = unb64url(m.dk)!
      const ekD = unb64url(m.ek)!
      const n = unb64url(m.n)!
      const cid = unb64url(this.computerId)!
      if (!verify(dk, unb64url(m.sig)!, hs1Input(cid, dk, ekD, n))) return
      const eph = boxKey()
      const th = transcriptHash(cid, dk, ekD, n, eph.pub)
      const keys = channelKeys(eph.priv, ekD, th)
      l.open = new FrameOpener(keys.d2h)
      l.seal = new FrameSealer(keys.h2d)
      this.to(link, { t: 'welcome', v: 1, ek: b64url(eph.pub), sig: b64url(this.sign.sign(th)) })
    } else if (m.t === 'f' && l.open) {
      const whole = l.open.open(m.c, unb64url(m.d)!)
      if (!whole) return
      const inner = JSON.parse(whole.toString('utf8'))
      if (inner.cancel) return void this.subs.delete(link)
      if (inner.sub === 'events') {
        this.subs.set(link, inner.id)
        return this.say(link, { id: inner.id, ev: { type: 'hello', hostId: this.computerId, rev: 1 } })
      }
      this.calls.push(inner.m)
      if (this.refuse) return this.say(link, { id: inner.id, err: { status: 403, message: 'Show the invite first.' } })
      if (inner.m === 'hello') this.say(link, { id: inner.id, ok: { name: 'Test Mac', computerId: this.computerId, backends: [], bots: [] } })
      else this.say(link, { id: inner.id, err: { status: 404, message: `unknown method ${inner.m}` } })
    }
  }
}

async function main() {
  if (!existsSync(WRANGLER)) throw new Error('wrangler is not installed: run `npm --prefix serve/cloud ci` first')
  const migrate = spawnSync(WRANGLER, ['d1', 'migrations', 'apply', 'kith-local', '--local', '--env', 'local', '--persist-to', persist], {
    cwd: CLOUD_DIR,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.stderr}`)
  const dev = spawn(WRANGLER, ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', persist, '--var', `CLERK_JWT_KEY:${jwtKey}`], {
    cwd: CLOUD_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dev.stdout?.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(String(d)))
  dev.stderr?.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(String(d)))
  children.push(dev)
  await waitFor('cloud /v1/health', () => fetch(`${CLOUD}/v1/health`).then((r) => r.ok).catch(() => false), 90_000)

  // The Mac registers and its owner account claims it.
  const mac = new FakeMac()
  check((await mac.register()).body.computerId === mac.computerId, 'the fake Mac registered')
  const owner = await clerkToken('user_desktop_owner')
  const claim = await cloud('POST', '/v1/claims', { token: owner })
  const boxKeyB64 = b64url(mac.box.pub)
  const claimInput = ['kith/claim/v1', claim.body.claimId, claim.body.nonce, 'user_desktop_owner', mac.computerId, boxKeyB64].join('\n')
  const done = await cloud('POST', `/v1/claims/${claim.body.claimId}/complete`, {
    token: owner,
    body: { computerId: mac.computerId, signKey: b64url(mac.sign.publicKey), boxKey: boxKeyB64, name: 'Test Mac', platform: 'macos', device: 'e2e', version: '0.1.0', sig: b64url(mac.sign.sign(Buffer.from(claimInput))) },
  })
  check(done.status === 200, 'the owner account claimed the Mac')

  // The desktop: a fresh device key registers with the account and lists the Mac (no access yet).
  const desktop = signerFromSeed(Buffer.alloc(32, 0x61)) // fake
  const req = (method: string, path: string, body: unknown, signed: boolean) =>
    cloud(method, `/${path}`, { token: owner, signer: signed ? desktop : undefined, body }).then((r) =>
      r.status >= 200 && r.status < 300 ? ({ ok: true, value: r.body } as const) : ({ ok: false, error: { status: r.status, code: r.body?.error?.code ?? `http${r.status}`, message: r.body?.error?.message ?? null } } as const),
    )
  check((await req('POST', 'v1/devices', { name: 'Desktop e2e', platform: 'macos' }, true)).ok, 'the desktop registered its device key')
  const listed = await req('GET', 'v1/computers', undefined, true)
  const row = listed.ok && (listed.value as any).computers.find((c: any) => c.computerId === mac.computerId)
  check(row && row.signKey === b64url(mac.sign.publicKey) && row.access === 'none', 'the Mac is listed with its sign key and no access yet')

  // Access request: the desktop commits and reveals; the Mac checks the same six digits and approves.
  await mac.connect([])
  const approving = (async () => {
    const pending = await waitFor('the request on the Mac', async () => (await cloud('GET', '/v1/host/state', { signer: mac.sign })).body.requests?.[0])
    check(pending.deviceKey === b64url(desktop.publicKey), 'the Mac sees the request from the desktop key')
    const nH = Buffer.alloc(32, 0x71)
    await cloud('POST', `/v1/host/access-requests/${pending.requestId}/nonce`, { signer: mac.sign, body: { nonce: b64url(nH) } })
    const revealed = await waitFor('the revealed nonce', async () => (await cloud('GET', '/v1/host/state', { signer: mac.sign })).body.requests?.[0]?.deviceNonce)
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from('kith/sascommit/v1'), desktop.publicKey, unb64url(revealed)!])).digest()
    check(b64url(expected) === pending.commit, 'the revealed nonce matches the commit')
    const code = sasCode(mac.sign.publicKey, desktop.publicKey, unb64url(revealed)!, nH)
    return { id: pending.requestId, code }
  })()
  const ticket = await requestAccess({ request: req, signer: desktop, computerId: mac.computerId, signKey: b64url(mac.sign.publicKey), cancelled: () => false, pollMs: 200 })
  check(ticket.ok, 'the desktop got a ticket')
  const hostSide = await approving
  check(ticket.ok && ticket.value.code === hostSide.code && /^\d{6}$/.test(ticket.value.code), `the desktop and the Mac show the same six digits (${hostSide.code})`)
  const decision = await cloud('POST', `/v1/host/access-requests/${hostSide.id}/decision`, { signer: mac.sign, body: { decision: 'approve' } })
  check(decision.status === 200 && decision.body.status === 'approved', 'the Mac approved the device')
  const state = await cloud('GET', '/v1/host/state', { signer: mac.sign })
  const grant = state.body.grants.find((g: any) => g.deviceKey === b64url(desktop.publicKey))
  check(grant, 'the grant names the desktop key')

  // The Mac publishes the new ACL; the desktop connects over the relay.
  mac.sendAcl([{ dk: b64url(desktop.publicKey), grant: grant.grantId }])
  const link = new RelayLink({ cloudURL: CLOUD, computerId: mac.computerId, hostSignKey: b64url(mac.sign.publicKey), signer: desktop })
  const hello = (await link.call('hello', {}, 15_000)) as { name: string }
  check(hello.name === 'Test Mac', 'hello answered end to end over the relay')

  const lines: string[] = []
  link.subscribe('events', { since: 0, client: 'desktop' }, (l) => lines.push(l), () => {})
  await waitFor('the first event', () => lines.length >= 1)
  mac.event({ type: 'usage', usage: { providers: [] } })
  await waitFor('a pushed event', () => lines.length >= 2)
  check(JSON.parse(lines[0]).type === 'hello' && JSON.parse(lines[1]).type === 'usage', 'the event stream delivered the Mac events')

  mac.refuse = true
  await link.call('send', {}, 5000).then(
    () => check(false, 'a refusal'),
    (e) => check(e.status === 403 && e.message === 'Show the invite first.', "a host's refusal comes up unchanged"),
  )
  mac.refuse = false

  // The Mac goes away and comes back: the channel survives on the same socket.
  mac.close()
  await waitFor('host offline', () => link.state.kind === 'hostOffline')
  await link.call('hello', {}, 1000).then(
    () => check(false, 'offline'),
    (e) => check(e.code === 'hostOffline', 'a call while the Mac is off says so'),
  )
  await mac.connect([{ dk: b64url(desktop.publicKey), grant: grant.grantId }])
  await waitFor('the channel back', () => link.state.kind === 'ready')
  check(((await link.call('hello', {}, 15_000)) as { name: string }).name === 'Test Mac', 'the channel comes back when the Mac does')

  // The Mac drops the device from its ACL: the relay closes the socket with 4003 and the client says so.
  mac.sendAcl([])
  await waitFor('access removed', () => link.state.kind === 'unauthorized')
  await link.call('hello', {}, 1000).then(
    () => check(false, 'removed'),
    (e) => check(e.code === 'accessRemoved' && e.status === 401, 'access removed surfaces as 401 accessRemoved'),
  )
  link.close()
  mac.close()
  console.log('\ndesktop relay e2e passed')
}

try {
  await main()
} catch (e) {
  console.error('\ndesktop relay e2e failed:', e)
  process.exitCode = 1
} finally {
  await Promise.all(children.map(stop))
  rmSync(tmp, { recursive: true, force: true })
}
