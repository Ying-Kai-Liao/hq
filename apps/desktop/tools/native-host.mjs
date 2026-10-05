// Builds the host the Mac app bundles (build/native/codync-host, universal) for the same
// environment as the app: CODYNC_ENV (dev | main, default dev) is compiled into the host's cloud.
// Built on every package so a host made for another environment is never shipped. Linux apps
// use the installed host, so there's nothing to do there.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)
const env = process.env.CODYNC_ENV ?? 'dev'
if (!['dev', 'main'].includes(env)) throw new Error(`unknown environment ${env}`)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = join(root, '../../host')
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin']
// The pinned toolchain (rust-toolchain.toml) through rustup, even when another cargo (Homebrew's)
// comes first on PATH: only rustup's has the x86_64 target.
const tool = (name) => execFileSync('rustup', ['which', name], { cwd: host, encoding: 'utf8' }).trim()
const [cargo, rustc] = [tool('cargo'), tool('rustc')]
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, CODYNC_ENV: env, RUSTC: rustc } })
for (const target of targets) run(cargo,['build', '--release', '--manifest-path', join(host, 'Cargo.toml'), '--target', target])
mkdirSync(join(root, 'build/native'), { recursive: true })
run('lipo', ['-create', '-output', join(root, 'build/native/codync-host'), ...targets.map((t) => join(host, 'target', t, 'release/codync-host'))])
console.log(`host: ${env}`)
