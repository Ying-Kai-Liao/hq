import { join } from 'node:path'

/**
 * Whether an installed service belongs to `kith serve` rather than this app: its definition sets
 * HQ_BIN, or it runs the binary `kith serve start` installs in the data folder. The app never
 * reinstalls such a service (that would drop HQ_BIN), even when its own binary resolves to the
 * same file in an unpackaged run.
 */
export function isKithServeService(definition: string, program: string | null, home: string, dataFolder: string): boolean {
  if (/\bHQ_BIN\b/.test(definition)) return true
  return program !== null && program.startsWith(join(home, dataFolder, 'bin') + '/')
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function xmlUnescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]!.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[body] ?? whole
  })
}

const SYSTEMD_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', s: ' ' }

/**
 * The executable of a systemd unit's ExecStart: the first word, which may be quoted (spaces
 * inside) and use C-style escapes (`\"`, `\\`, `\s`, `\xNN`). The prefix characters (`-`, `@`,
 * `:`, `+`, `!`) before it are not part of the path.
 */
export function systemdProgram(definition: string): string | null {
  const line = /^ExecStart=[ \t]*(.*)$/m.exec(definition)?.[1]
  if (line === undefined) return null
  let i = 0
  while (i < line.length && '@-:+!'.includes(line[i]!)) i++
  const quote = line[i] === '"' || line[i] === "'" ? line[i++] : null
  let out = ''
  for (; i < line.length; i++) {
    const c = line[i]!
    if (quote ? c === quote : /\s/.test(c)) break
    if (c !== '\\' || i + 1 >= line.length) {
      out += c
      continue
    }
    const next = line[++i]!
    const hex = next === 'x' ? /^[0-9a-f]{2}/i.exec(line.slice(i + 1))?.[0] : undefined
    if (hex) {
      out += String.fromCharCode(parseInt(hex, 16))
      i += 2
    } else out += SYSTEMD_ESCAPES[next] ?? next
  }
  return out === '' ? null : out
}

/** The first ProgramArguments entry of a launchd plist, with its XML entities decoded. */
export function launchdProgram(definition: string): string | null {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(definition)
  return match ? xmlUnescape(match[1]!) : null
}

export type CommandRunner = (bin: string, args: string[]) => Promise<{ status: number; output: string }>

export interface ServiceRestart {
  platform: 'mac' | 'linux'
  uid: number
  /** launchd label and the plist the service was installed from. */
  label: string
  plistPath: string
  systemdUnit: string
  run: CommandRunner
}

/**
 * Restarts a service the app adopted, starting it first when its manager has it stopped: `kith
 * serve stop` unloads the launchd job (`bootout`) but leaves the plist, and `kickstart` cannot
 * load a job. The existing definition is loaded as it is, never rewritten.
 */
export async function restartService(s: ServiceRestart): Promise<{ status: number; output: string }> {
  if (s.platform === 'linux') {
    const active = await s.run('systemctl', ['--user', 'is-active', '--quiet', s.systemdUnit])
    return s.run('systemctl', ['--user', active.status === 0 ? 'restart' : 'start', s.systemdUnit])
  }
  const domain = `gui/${s.uid}`
  const loaded = await s.run('launchctl', ['print', `${domain}/${s.label}`])
  if (loaded.status !== 0) {
    const boot = await s.run('launchctl', ['bootstrap', domain, s.plistPath])
    if (boot.status !== 0) return boot
  }
  return s.run('launchctl', ['kickstart', '-k', `${domain}/${s.label}`])
}
