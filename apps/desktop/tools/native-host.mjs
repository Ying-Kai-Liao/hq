// Builds the host the app bundles for the same environment as the app: node tools/native-host.mjs
// dev|main compiles it in as KITH_SERVE_ENV. Built on every package so a host made for another
// environment is never shipped. macOS: build/native/kith-serve and build/native/kith/ (bin/kith +
// share/kith/kernel, the release layout; universal; Kith Dev: this Mac's
// architecture only, since it never leaves the Mac that built it). Windows:
// build/native/kith-serve.exe and kith-servew.exe (kith-servew-main.exe for main; runs it at sign-in), plus the computer-use
// driver the host starts from beside itself. Linux apps use the installed host, so there's
// nothing to do there.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!['darwin', 'win32'].includes(process.platform)) process.exit(0)
const env = process.argv[2]
if (!['dev', 'main'].includes(env)) throw new Error(`unknown environment ${env}`)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = join(root, '../../serve/host')
const out = join(root, 'build/native')
// The pinned toolchain (rust-toolchain.toml) through rustup, even when another cargo (Homebrew's)
// comes first on PATH: only rustup's has the x86_64 target.
const tool = (name) => execFileSync('rustup', ['which', name], { cwd: host, encoding: 'utf8' }).trim()
const [cargo, rustc] = [tool('cargo'), tool('rustc')]
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, KITH_SERVE_ENV: env, RUSTC: rustc } })
// Kith Dev builds in the host's `dev-app` profile: seconds to rebuild instead of minutes.
const profile = env === 'dev' ? 'dev-app' : 'release'
const build = (target) => run(cargo, ['build', '--profile', profile, '--manifest-path', join(host, 'Cargo.toml'), '--target', target])
// Cargo names a profile's folder after it, except dev/release.
const built = (target, name) => join(process.env.CARGO_TARGET_DIR ?? join(host, 'target'), target, profile, name)
mkdirSync(out, { recursive: true })
if (process.platform === 'win32') {
  const target = 'x86_64-pc-windows-msvc'
  build(target)
  // The host builds one supervisor; the main app ships it under the main name (environment.rs).
  copyFileSync(built(target, 'kith-serve.exe'), join(out, 'kith-serve.exe'))
  copyFileSync(built(target, 'kith-servew.exe'), join(out, env === 'dev' ? 'kith-servew.exe' : 'kith-servew-main.exe'))
  run(process.execPath, [join(root, '../packaging/cua-driver/fetch.mjs'), 'windows-x86_64', out])
} else {
  const native = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const targets = env === 'dev' ? [native] : ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  for (const target of targets) build(target)
  run('lipo', ['-create', '-output', join(out, 'kith-serve'), ...targets.map((t) => built(t, 'kith-serve'))])
  // The same crate's `kith` name, laid out like the release tarball (bin/kith, share/kith/kernel...) so the
  // bundled kith finds its kernel the way an installed one does. The service keeps running kith-serve.
  const kith = join(out, 'kith')
  rmSync(kith, { recursive: true, force: true })
  mkdirSync(join(kith, 'bin'), { recursive: true })
  run('lipo', ['-create', '-output', join(kith, 'bin/kith'), ...targets.map((t) => built(t, 'kith'))])
  run('sh', [join(root, '../../scripts/stage-kernel.sh'), join(kith, 'share/kith')])
  // kernel/bin/hq-serve reads this to use the main environment's data dir and port instead of the dev ones.
  writeFileSync(join(kith, 'share/kith/env'), `${env}\n`)
}
console.log(`host: ${env}`)
