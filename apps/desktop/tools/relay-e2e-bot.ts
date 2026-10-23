// Bot guests against the real pieces: the real `kith-guest` binary (the client a cloud bot's VM runs) against the same
// kith-serve and wrangler dev as relay-e2e-host.ts. Called from there when KITH_GUEST_BIN is set.
//
//   Kai-owned bot: owner makes the invite (the Local caller), `join` takes it and is active at once, `ask` streams an
//   answer, `--thread` continues the conversation, a retried idempotency key sends once, `revokeBot` makes the next
//   ask exit 6.
//   Invitee-owned bot: `join` waits for the owner's allow (exit 5), `decideBot` allows it, then the Mac goes offline
//   (exit 10).

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface BotCtx {
  guestBin: string
  cloud: string
  tmp: string
  /** The owner on the Mac itself (the Local caller). */
  loopback: (method: string, body?: unknown) => Promise<any>
  /** A member's call over the relay. */
  member: (method: string, body?: unknown) => Promise<any>
  /** Stops the host process, so the Mac is offline. */
  stopHost: () => Promise<void>
  check: (cond: unknown, what: string) => asserts cond
}

interface Run {
  code: number | null
  out: string
  err: string
  events: any[]
}

const EXIT = { ok: 0, pending: 5, removed: 6, offline: 10 }

export async function botGuests(c: BotCtx) {
  console.log('\nbot guests:')
  const guest = (home: string, args: string[], ms = 120_000) =>
    new Promise<Run>((resolve, reject) => {
      const env = { ...process.env }
      for (const k of ['KITH_GUEST_CREDENTIALS', 'KITH_CLOUD_URL', 'KITH_GUEST_HOME']) delete env[k]
      const child = spawn(c.guestBin, ['--home', home, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`kith-guest ${args.join(' ')} timed out\n${out}\n${err}`))
      }, ms)
      child.on('close', (code) => {
        clearTimeout(timer)
        const events = out
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l))
        resolve({ code, out, err, events })
      })
    })
  const why = (r: Run) => `exit ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`
  const expectExit = (r: Run, code: number, what: string) => c.check(r.code === code, `${what} (${r.code === code ? 'exit ' + code : why(r)})`)

  const dbCount = (sql: string) => {
    const db = join(c.tmp, 'home/serve.db')
    const r = spawnSync('python3', ['-I', '-c', 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()[0])', db, sql], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`sqlite: ${r.stderr}`)
    return Number(r.stdout.trim())
  }

  // ---- the computer owner's own bot ----
  const home1 = join(c.tmp, 'guest1')
  mkdirSync(home1, { recursive: true })
  const made = await c.loopback('createBotInvite', { name: 'Rex', provider: 'grok', agents: ['house'] })
  c.check(typeof made.link === 'string' && made.link.startsWith(`${c.cloud}/b/`) && made.link.includes('#t='), `the owner got a link (${made.link})`)
  const botId = made.botId as string

  const joined = await guest(home1, ['join', made.link, '--wait', '60'])
  expectExit(joined, EXIT.ok, 'join took the owner\'s link and the bot is in')
  c.check(joined.out.includes('Joined'), 'join said so')
  expectExit(await guest(home1, ['join', made.link, '--wait', '30']), EXIT.ok, 'joining twice with the same link is a no-op')

  const st = await guest(home1, ['--json', 'status'])
  expectExit(st, EXIT.ok, 'status')
  const sv = st.events.at(-1)
  c.check(sv.state === 'active' && sv.host === 'online' && sv.agents[0]?.agent === 'house', `status: active, online, house (${JSON.stringify(sv)})`)
  const ag = await guest(home1, ['agents'])
  c.check(ag.code === 0 && ag.out.includes('house'), 'agents lists house')

  const asked = await guest(home1, ['--json', 'ask', '@house', 'hi there', '--timeout', '90', '--idempotency-key', 'nonce-1'])
  expectExit(asked, EXIT.ok, 'ask got an answer')
  const conv = asked.events.find((e) => e.type === 'conversation')?.conversation as string
  const done = asked.events.find((e) => e.type === 'done')
  c.check(/^cv_/.test(conv), `the ask opened a conversation (${conv})`)
  c.check(done?.text?.includes('Echo:') && done.text.includes('hi there'), `the answer streamed back (${done?.text?.slice(-60)})`)

  const again = await guest(home1, ['--json', 'ask', '@house', 'hi there', '--thread', conv, '--timeout', '90', '--idempotency-key', 'nonce-1'])
  expectExit(again, EXIT.ok, 'the same ask retried with its key')
  c.check(
    dbCount(`SELECT COUNT(*) FROM entries WHERE kind='user' AND json_extract(data,'$.clientNonce')='nonce-1'`) === 1,
    'a retried ask sent one turn, not two',
  )

  const next = await guest(home1, ['--json', 'ask', '@house', '--thread', conv, 'and then?', '--timeout', '90'])
  expectExit(next, EXIT.ok, '--thread continues the conversation')
  c.check(next.events.find((e) => e.type === 'conversation')?.conversation === conv, 'the same conversation')
  c.check(next.events.find((e) => e.type === 'done')?.text?.includes('and then?'), 'the continued turn answered')
  c.check(dbCount(`SELECT COUNT(*) FROM entries WHERE kind='user' AND json_extract(data,'$.sender.name')='Rex'`) === 2, 'both turns are in one thread, from Rex')

  await c.loopback('revokeBot', { botId })
  const gone = await guest(home1, ['ask', '@house', 'still there?', '--timeout', '30'])
  expectExit(gone, EXIT.removed, 'after revokeBot the next ask exits 6')

  // ---- a member's bot waits for the computer owner ----
  const home2 = join(c.tmp, 'guest2')
  mkdirSync(home2, { recursive: true })
  const theirs = await c.member('createBotInvite', { name: 'Mia Bot', provider: 'other', agents: ['house'] })
  const waiting = await guest(home2, ['join', theirs.link, '--wait', '8'])
  expectExit(waiting, EXIT.pending, 'join of a member\'s bot waits for the owner (exit 5)')
  expectExit(await guest(home2, ['ask', '@house', 'may I?', '--timeout', '20']), EXIT.pending, 'an ask while pending exits 5')
  await c.loopback('decideBot', { botId: theirs.botId, decision: 'allow' })
  expectExit(await guest(home2, ['join', theirs.link, '--wait', '30']), EXIT.ok, 'after the allow the same link finishes joining')
  const ok2 = await guest(home2, ['--json', 'ask', '@house', 'now?', '--timeout', '90'])
  expectExit(ok2, EXIT.ok, 'the allowed bot asks')
  c.check(ok2.events.find((e) => e.type === 'done')?.text?.includes('now?'), 'and gets its answer')

  // ---- the Mac goes away ----
  await c.stopHost()
  const off = await guest(home2, ['ask', '@house', 'anyone?', '--timeout', '20'])
  expectExit(off, EXIT.offline, 'with the Mac offline, ask exits 10')
  console.log('\nbot guests e2e passed')
}
