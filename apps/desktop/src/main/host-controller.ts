import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { HostState, LocalHost } from '../shared/ipc'
import { unregisterScreenAgent } from './screen'

/** `CODYNC_PORT` / `CODYNC_HOME` point the app at a dev host started with `codync-host serve`. */
export const devPort = process.env.CODYNC_PORT ? Number(process.env.CODYNC_PORT) : null
export const port = devPort ?? 19222
export const dataDir = process.env.CODYNC_HOME ?? join(homedir(), '.codync')
export const baseURL = `http://127.0.0.1:${port}`

interface Health {
  ok?: boolean
  computerId?: string
  binaryPath?: string
  binaryHash?: string
  busy?: boolean
}

export async function fetchHealth(url = baseURL, timeoutMs = 2000): Promise<Health | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

export function run(bin: string, args: string[]): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ status, output: `${stdout}${stderr}`.trim() })
    })
  })
}

const isMac = platform() === 'darwin'

/** The service definition `codync-host install` writes. */
const serviceFile = isMac
  ? join(homedir(), 'Library/LaunchAgents/com.pokai.codync.host.plist')
  : join(homedir(), '.config/systemd/user/codync-host.service')

/**
 * Manages the local codync-host (binary, background service, health) the way the native
 * apps did: bundled next to the app, else a Homebrew / cargo install.
 */
export class HostController extends EventEmitter {
  state: HostState = { kind: 'starting' }
  local: LocalHost | null = null
  private loop: NodeJS.Timeout | null = null
  private generation = 0
  private installing = false
  private replacedStale = false
  private expectedHash: string | null = null
  private failures = 0
  private preparingForUpdate = false

  get binary(): string | null {
    const candidates = [
      app.isPackaged ? join(process.resourcesPath, 'codync-host') : null,
      process.env.CODYNC_HOST_BIN ?? null,
      '/opt/homebrew/bin/codync-host',
      '/usr/local/bin/codync-host',
      '/usr/bin/codync-host',
      join(homedir(), '.cargo/bin/codync-host'),
    ]
    return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
  }

  get logPath() {
    return join(dataDir, 'host.log')
  }

  private setState(state: HostState) {
    this.state = state
    this.emit('change')
  }

  private setLocal(local: LocalHost | null) {
    this.local = local
    this.emit('change')
  }

  start() {
    void this.refresh()
  }

  private uninstalled() {
    return prefs.get('hostUninstalled') === true
  }

  async refresh() {
    if (this.preparingForUpdate) return
    if (!this.binary && devPort === null) return this.setState({ kind: 'missingBinary' })
    if (devPort === null && prefs.get('hostRestartAfterAppUpdate') === true && existsSync(serviceFile)) return this.install()
    if (devPort === null && !existsSync(serviceFile)) {
      // The app is the way to run the host: set it up right away, unless the user took it out.
      if (this.uninstalled()) return this.setState({ kind: 'notInstalled' })
      return this.install()
    }
    this.connect()
  }

  /** `codync-host install` also routes Claude Code's status line through the host. */
  async install() {
    const bin = this.binary
    if (this.preparingForUpdate || this.installing || !bin) return
    this.installing = true
    this.stopLoop()
    prefs.set('hostUninstalled', false)
    this.setState({ kind: 'starting' })
    try {
      const result = await run(bin, ['install', '--port', String(port)])
      if (result.status !== 0) {
        this.setState({ kind: 'failed', message: result.output || 'Install failed' })
      } else {
        await sleep(1000)
        this.connect()
      }
    } finally {
      this.installing = false
    }
  }

  restart() {
    if (devPort !== null) {
      this.setState({ kind: 'failed', message: 'Restart the manually started development host in its terminal.' })
      return
    }
    this.replacedStale = false
    void this.install()
  }

  async uninstall() {
    const bin = this.binary
    if (!bin) return
    this.stopLoop()
    prefs.set('hostUninstalled', true)
    await run(bin, ['uninstall'])
    this.setLocal(null)
    this.setState({ kind: 'notInstalled' })
  }

  /** Stops the service before the app replaces itself; `resumeAfterCancelledUpdate` undoes it. */
  async prepareForUpdate() {
    if (devPort !== null) return
    if (this.installing) throw new Error('The host is being installed. Try again when it finishes.')
    this.preparingForUpdate = true
    if (existsSync(serviceFile)) prefs.set('hostRestartAfterAppUpdate', true)
    this.stopLoop()
    unregisterScreenAgent()
    const bin = this.binary
    if (!bin) throw new Error('The bundled host is missing.')
    const result = await run(bin, ['stop'])
    if (result.status !== 0) throw new Error(result.output || 'The old host could not be stopped.')
  }

  resumeAfterCancelledUpdate() {
    if (!this.preparingForUpdate) return
    this.preparingForUpdate = false
    if (existsSync(serviceFile)) void this.install()
    else void this.refresh()
  }

  async isIdleForUpdate(): Promise<boolean> {
    if (this.installing || this.preparingForUpdate || devPort !== null) return false
    if (!existsSync(serviceFile)) return true
    const health = await fetchHealth()
    return health?.busy === false
  }

  private stopLoop() {
    this.generation++
    if (this.loop) clearTimeout(this.loop)
    this.loop = null
  }

  /** Watches the host's health; the renderer's store handles the event stream itself. */
  private connect() {
    if (this.preparingForUpdate) return
    this.stopLoop()
    const generation = this.generation
    this.failures = 0
    const tick = async () => {
      if (generation !== this.generation) return
      if (await this.attachLocal()) {
        this.failures = 0
        if (generation !== this.generation) return
        this.setState({ kind: 'running' })
        if (devPort === null && prefs.get('hostRestartAfterAppUpdate') === true) prefs.set('hostRestartAfterAppUpdate', false)
      } else {
        this.failures++
        if (this.failures > 5) this.setState({ kind: 'failed', message: "The host isn't responding. See the log for details." })
        else if (this.state.kind !== 'running') this.setState({ kind: 'starting' })
      }
      if (generation === this.generation) this.loop = setTimeout(tick, 5000)
    }
    void (async () => {
      const bin = this.binary
      if (bin && devPort === null) this.expectedHash = await hashFile(bin)
      void tick()
    })()
  }

  /** Attaches the local host once it answers, and again when its token or identity changed. */
  private async attachLocal(): Promise<boolean> {
    const token = await readToken()
    const health = await fetchHealth()
    if (!token || !health?.computerId) return false
    if (devPort === null) {
      // A rebuild can change the host without changing the release version.
      const bin = this.binary
      if (!this.expectedHash || !bin) return false
      const matches = health.binaryHash === this.expectedHash && health.binaryPath === resolved(bin)
      if (!matches) {
        if (!this.replacedStale) {
          this.replacedStale = true
          void this.install()
        }
        return false
      }
    }
    if (this.local?.computerId === health.computerId && this.local.token === token) return true
    this.setLocal({ computerId: health.computerId, baseURL, token })
    return true
  }
}

async function readToken(): Promise<string | null> {
  try {
    return (await fs.readFile(join(dataDir, 'token'), 'utf8')).trim() || null
  } catch {
    return null
  }
}

async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(path)).digest('hex')
  } catch {
    return null
  }
}

function resolved(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Main-process preferences (a small JSON file in the app's data folder). */
export const prefs = (() => {
  const file = () => join(app.getPath('userData'), 'host-prefs.json')
  let cache: Record<string, unknown> | null = null
  const load = () => {
    if (cache) return cache
    try {
      cache = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
    } catch {
      cache = {}
    }
    return cache
  }
  return {
    get: (key: string) => load()[key],
    set: (key: string, value: unknown) => {
      const data = load()
      data[key] = value
      void fs.mkdir(app.getPath('userData'), { recursive: true }).then(() => fs.writeFile(file(), JSON.stringify(data)))
    },
  }
})()
