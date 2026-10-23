#!/usr/bin/env node
// Builds THIRD_PARTY_NOTICES.md from what Kith ships, and checks every license against scripts/notices/policy.json.
//
//   node scripts/notices/generate.mjs           write THIRD_PARTY_NOTICES.md
//   node scripts/notices/generate.mjs --check   fail if the file is stale or a license breaks the policy (CI)
//
// Inputs: Cargo.lock (crates come from the cargo registry, or crates.io when not cached), the npm lockfiles with
// node_modules installed (run `npm ci --ignore-scripts` first), SwiftPM Package.resolved files (license text from
// the tag on GitHub), and the vendored/extras lists in policy.json. Output is sorted, so a rerun is identical.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md')
const policy = JSON.parse(readFileSync(join(ROOT, 'scripts/notices/policy.json'), 'utf8'))
const CACHE = process.env.NOTICES_CACHE || join(homedir(), '.cache', 'kith-notices')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const norm = (t) => t.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\s+$/g, '')

// ---- license ids -------------------------------------------------------------------------------------------

const detectors = [
  [/Apache License\s+Version 2\.0/i, 'Apache-2.0'],
  [/Mozilla Public License,? (Version|v\.?) 2\.0/i, 'MPL-2.0'],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL-3.0'],
  [/GNU GENERAL PUBLIC LICENSE/i, 'GPL-3.0'],
  [/Boost Software License/i, 'BSL-1.0'],
  [/free and unencumbered software released into the public domain/i, 'Unlicense'],
  [/CC0 1\.0 Universal/i, 'CC0-1.0'],
  [/UNICODE LICENSE V3/i, 'Unicode-3.0'],
  [/Unicode,? Inc\. License Agreement/i, 'Unicode-DFS-2016'],
  [/altered source versions must be plainly marked/i, 'Zlib'],
  [/Redistribution and use in source and binary forms[\s\S]*Neither the name/i, 'BSD-3-Clause'],
  [/Redistribution and use in source and binary forms/i, 'BSD-2-Clause'],
  [/Permission to use, copy, modify, and\/or distribute this software for any\s+purpose with or without fee/i, 'ISC'],
  [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, '0BSD'],
  [/Permission is hereby granted, free of charge/i, 'MIT'],
]
export const detect = (text) => detectors.find(([re]) => re.test(text))?.[1] ?? null

const glob = (pat, id) => new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(id)
const anyGlob = (pats, id) => pats.some((p) => glob(p, id))

/** allowed | review | denied | unknown for one SPDX id. */
function idStatus(id) {
  const base = id.replace(/\+$/, '')
  if (anyGlob(policy.deny, base)) return 'denied'
  if (anyGlob(policy.review, base)) return 'review'
  if (policy.allow.includes(base)) return 'allowed'
  return 'unknown'
}
const RANK = { allowed: 0, review: 1, unknown: 2, denied: 3 }

/** Parses an SPDX expression and returns {status, ids}: OR picks the best branch (policy.prefer breaks ties), AND needs every branch. */
export function evalSpdx(expr) {
  const tokens = expr.replace(/\//g, ' OR ').match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  const pref = (ids) => Math.min(...ids.map((x) => { const k = policy.prefer.indexOf(x.replace(/\+$/, '')); return k < 0 ? 99 : k }))
  const parseOr = () => {
    let best = parseAnd()
    while (tokens[i]?.toUpperCase() === 'OR') {
      i++
      const next = parseAnd()
      if (RANK[next.status] < RANK[best.status] || (next.status === best.status && pref(next.ids) < pref(best.ids))) best = next
    }
    return best
  }
  const parseAnd = () => {
    let cur = parseAtom()
    while (tokens[i]?.toUpperCase() === 'AND') {
      i++
      const next = parseAtom()
      cur = { status: RANK[next.status] > RANK[cur.status] ? next.status : cur.status, ids: [...cur.ids, ...next.ids] }
    }
    return cur
  }
  const parseAtom = () => {
    const t = tokens[i++]
    if (t === '(') {
      const r = parseOr()
      i++ // ')'
      return r
    }
    if (t === undefined) return { status: 'unknown', ids: ['UNKNOWN'] }
    if (tokens[i]?.toUpperCase() === 'WITH') i += 2 // "Apache-2.0 WITH LLVM-exception": the base license decides
    return { status: idStatus(t), ids: [t] }
  }
  const r = parseOr()
  return { status: r.status, ids: [...new Set(r.ids)] }
}

// ---- texts and copyrights ----------------------------------------------------------------------------------

const COPY_RE = /^\s*(copyright\b|\(c\)\s+(19|20)\d\d|©)/i
const TEMPLATE_RE = /\[yyyy\]|\{yyyy\}|<year>|\[year\]|\[name of|copyright (owner|holder|notice|license)/i
const isCopyright = (l) => COPY_RE.test(l) && !TEMPLATE_RE.test(l) && l.length < 220
const copyrights = (text) => [...new Set(text.split('\n').filter(isCopyright).map((l) => l.trim().replace(/\s+/g, ' ')))]

/** The license body with its copyright lines taken out, so one MIT text serves every package that carries it. */
function body(text) {
  const lines = norm(text).split('\n')
  let marked = false
  const out = []
  for (const l of lines) {
    if (isCopyright(l)) {
      if (!marked) out.push('Copyright (c) the holders named for each package above')
      marked = true
    } else out.push(l)
  }
  return norm(out.join('\n').replace(/\n{3,}/g, '\n\n'))
}

const LICENSE_FILE = /^(licen[sc]e|copying|unlicen[sc]e|copyright)([-._].*)?$/i
const NOTICE_FILE = /^notice([-._].*)?$/i
function packageFiles(dir) {
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
  const pick = (re) => names.filter((n) => re.test(n) && !/\.(rs|js|ts|json|toml|c|h|py)$/i.test(n)).map((n) => ({ name: n, text: norm(readFileSync(join(dir, n), 'utf8')) })).filter((f) => f.text)
  return { licenses: pick(LICENSE_FILE), notices: pick(NOTICE_FILE) }
}

// ---- network helpers ---------------------------------------------------------------------------------------

async function cached(url, key) {
  const f = join(CACHE, key)
  if (existsSync(f)) return readFileSync(f)
  const r = await fetch(url)
  if (!r.ok) return null
  const buf = Buffer.from(await r.arrayBuffer())
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, buf)
  return buf
}
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k]) }
  }))
  return out
}

// ---- collectors --------------------------------------------------------------------------------------------

const tomlStr = (toml, key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1]

async function cargoPackages(lockPath) {
  const lock = read(lockPath)
  const crates = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "registry\+[^"]+"/g)].map((m) => ({ name: m[1], version: m[2] }))
  const reg = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'registry', 'src')
  const roots = existsSync(reg) ? readdirSync(reg).map((d) => join(reg, d)) : []
  const tmp = mkdtempSync(join(tmpdir(), 'kith-crates-'))
  try {
    return await pool(crates, 8, async ({ name, version }) => {
      let dir = roots.map((r) => join(r, `${name}-${version}`)).find(existsSync)
      if (!dir) {
        const buf = await cached(`https://static.crates.io/crates/${name}/${name}-${version}.crate`, `crates/${name}-${version}.crate`)
        if (!buf) throw new Error(`cannot fetch crate ${name} ${version}`)
        const f = join(tmp, `${name}-${version}.crate`)
        writeFileSync(f, buf)
        execFileSync('tar', ['-xzf', f, '-C', tmp])
        dir = join(tmp, `${name}-${version}`)
      }
      const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8').split(/^\[(?!package\])/m)[0]
      const { licenses, notices } = packageFiles(dir)
      return { eco: 'cargo', name, version, license: tomlStr(toml, 'license'), url: tomlStr(toml, 'repository') ?? `https://crates.io/crates/${name}`, licenses, notices, authors: (toml.match(/^authors\s*=\s*\[([\s\S]*?)\]/m)?.[1].match(/"([^"]+)"/g) ?? []).map((a) => a.slice(1, -1)) }
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function npmPackages({ name: proj, dir, bundled }) {
  const lock = JSON.parse(read(`${dir}/package-lock.json`))
  const pkg = JSON.parse(read(`${dir}/package.json`))
  const nm = join(ROOT, dir, 'node_modules')
  if (!existsSync(nm)) throw new Error(`${dir}/node_modules is missing: run npm ci --ignore-scripts there first`)
  const resolve = (from, dep) => {
    for (let base = from; ; base = base.slice(0, base.lastIndexOf('/node_modules/')) || '') {
      const p = (base ? base + '/' : '') + 'node_modules/' + dep
      if (lock.packages[p]) return p
      if (!base) return null
    }
  }
  const seen = new Set()
  const walk = (from, dep) => {
    const p = resolve(from, dep)
    if (!p || seen.has(p)) return
    seen.add(p)
    const e = lock.packages[p]
    for (const d of Object.keys({ ...e.dependencies, ...e.optionalDependencies })) walk(p, d)
  }
  for (const d of [...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }), ...bundled]) {
    if (!lock.packages['node_modules/' + d]) throw new Error(`${dir}: bundled dependency ${d} is not in the lockfile`)
    walk('', d)
  }
  return [...seen].filter((p) => !lock.packages[p].link).map((p) => {
    const e = lock.packages[p]
    const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const d = join(ROOT, dir, p)
    if (!existsSync(d)) throw new Error(`${dir}: ${p} is in the lockfile but not installed (optional platform package?)`)
    const meta = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    const lic = e.license ?? meta.license ?? (meta.licenses ?? []).map((l) => l.type ?? l).join(' OR ')
    const url = String(typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? meta.homepage ?? `https://www.npmjs.com/package/${name}`).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/')
    const { licenses, notices } = packageFiles(d)
    return { eco: 'npm', name, version: e.version, license: typeof lic === 'object' ? lic?.type : lic, url, licenses, notices, authors: [typeof meta.author === 'string' ? meta.author : meta.author?.name].filter(Boolean) }
  })
}

async function swiftPackages(file) {
  if (!existsSync(join(ROOT, file))) return []
  const j = JSON.parse(read(file))
  const pins = j.pins ?? j.object?.pins ?? []
  return pool(pins, 4, async (p) => {
    const location = p.location ?? p.repositoryURL
    const m = location.match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/)
    const name = p.identity ?? p.package
    const version = p.state.version ?? p.state.revision.slice(0, 12)
    if (!m) throw new Error(`${name}: only GitHub packages are supported (${location})`)
    let text = null
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'License.txt']) {
      const buf = await cached(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${p.state.revision}/${f}`, `swift/${m[1]}-${m[2]}-${p.state.revision}-${f}`)
      if (buf) { text = norm(buf.toString('utf8')); break }
    }
    return { eco: 'swiftpm', name, version, license: text ? detect(text) : null, url: `https://github.com/${m[1]}/${m[2]}`, licenses: text ? [{ name: 'LICENSE', text }] : [], notices: [] }
  })
}

function vendoredPackages() {
  return policy.vendored.map((v) => {
    const text = norm(read(v.file))
    return { eco: 'vendored', name: v.name, version: v.version ?? '', license: v.license ?? detect(text), url: v.url, note: v.note, licenses: [{ name: v.file, text }], notices: [] }
  })
}

async function extraPackages(known) {
  return pool(policy.extras, 2, async (x) => {
    let version = x.version
    if (x.versionFrom) {
      const [, dir, dep] = x.versionFrom.split(':')
      version = JSON.parse(read(`${dir}/package-lock.json`)).packages['node_modules/' + dep].version
    }
    const ref = x.ref.replace('{version}', version)
    const buf = await cached(`https://raw.githubusercontent.com/${x.github}/${ref}/LICENSE`, `extra/${x.github.replace('/', '-')}-${ref}-LICENSE`)
    if (!buf) throw new Error(`cannot fetch the license of ${x.name} ${ref}`)
    return { eco: 'bundled', name: x.name, version, license: x.license, url: `https://github.com/${x.github}`, note: x.note, licenses: [{ name: 'LICENSE', text: norm(buf.toString('utf8')) }], notices: [] }
  })
}

// ---- resolve, check, render --------------------------------------------------------------------------------

function resolveAll(pkgs) {
  const problems = []
  const used = new Set()
  const out = []
  for (const p of pkgs) {
    const keys = [`${p.eco}:${p.name}@${p.version}`, `${p.eco}:${p.name}`]
    const ex = keys.map((k) => (policy.exceptions[k] ? [k, policy.exceptions[k]] : null)).find(Boolean)
    if (ex) {
      used.add(ex[0])
      if (!ex[1].reason?.trim()) problems.push(`${ex[0]}: an exception needs a written "reason"`)
    }
    let expr = ex?.[1].license ?? p.license
    if (!expr) {
      const ids = [...new Set(p.licenses.map((f) => detect(f.text)).filter(Boolean))]
      expr = ids.join(' AND ')
    }
    const r = expr ? evalSpdx(expr) : { status: 'unknown', ids: ['UNKNOWN'] }
    let status = r.status
    if (status !== 'allowed' && ex && ex[1].reason?.trim()) status = 'excepted'
    if (status === 'denied' || status === 'review' || status === 'unknown') {
      const why = { denied: 'is not allowed', review: 'needs review (add an exception with a reason once someone has)', unknown: 'is not on the allow list or is missing' }[status]
      problems.push(`${p.eco}:${p.name}@${p.version}: license "${expr || 'none'}" ${why}`)
    }
    // The text that belongs to the license we rely on; every file when none can be told apart.
    const wanted = new Set(r.ids)
    const matching = p.licenses.filter((f) => wanted.has(detect(f.text)))
    let files = matching.length ? matching : p.licenses
    if (!files.length) {
      // Some packages ship no license file; the standard text for the declared license stands in.
      const t = r.ids.length === 1 && existsSync(join(ROOT, 'scripts/notices/templates', r.ids[0] + '.txt')) ? norm(read(`scripts/notices/templates/${r.ids[0]}.txt`)) : null
      if (t) files = [{ name: 'template', text: t }]
      else problems.push(`${p.eco}:${p.name}@${p.version}: ships no license text and scripts/notices/templates has none for "${expr}"`)
    }
    out.push({ ...p, ids: r.ids, group: r.ids.join(' AND '), files, status })
  }
  for (const k of Object.keys(policy.exceptions)) if (!used.has(k)) problems.push(`${k}: exception matches no package (remove it)`)
  return { out, problems }
}

function render(pkgs, notice) {
  const groups = new Map()
  for (const p of pkgs) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p) }
  const fence = '~~~~~'
  const lines = ['# Third-party notices', '', '<!-- Generated by scripts/notices/generate.mjs. Do not edit by hand. -->', '', ...notice.trim().split('\n'), '']
  lines.push(`Kith includes ${pkgs.length} third-party packages and vendored files under the licenses below.`, '')
  for (const g of [...groups.keys()].sort()) {
    const members = groups.get(g).sort((a, b) => (a.eco + a.name + a.version).localeCompare(b.eco + b.name + b.version, 'en'))
    lines.push(`## ${g}`, '')
    for (const p of members) {
      lines.push(`- ${p.name} ${p.version} (${p.eco})`.replace(/  +/g, ' '))
      if (p.url) lines.push(`  ${p.url}`)
      if (p.note) lines.push(`  ${p.note}`)
      const c = [...new Set(p.files.flatMap((f) => copyrights(f.text)))].slice(0, 4)
      for (const l of c) lines.push(`  ${l}`)
      // Many crates leave the holder to Cargo.toml / package.json.
      if (!c.length && p.authors?.length) lines.push(`  Copyright ${p.authors.join(', ').replace(/\s+/g, ' ')}`)
      for (const n of p.notices) for (const l of n.text.split('\n').filter((x) => x.trim())) lines.push(`  ${l.trim()}`)
    }
    lines.push('')
    const texts = new Map()
    for (const p of members) for (const f of p.files) { const b = body(f.text); texts.set(createHash('sha256').update(b).digest('hex'), b) }
    for (const b of [...texts.values()].sort()) {
      if (b.includes(fence)) throw new Error('a license text contains the fence line')
      lines.push(fence, b, fence, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

async function main() {
  const check = process.argv.includes('--check')
  const pkgs = []
  for (const f of policy.cargo) pkgs.push(...(await cargoPackages(f)))
  for (const n of policy.npm) pkgs.push(...npmPackages(n))
  const swift = (await Promise.all(policy.swiftpm.map(swiftPackages))).flat()
  pkgs.push(...new Map(swift.map((p) => [p.name + p.version, p])).values())
  pkgs.push(...vendoredPackages(), ...(await extraPackages()))
  // The same package reached from two lockfiles is one entry.
  const unique = [...new Map(pkgs.map((p) => [`${p.eco}:${p.name}@${p.version}`, p])).values()]

  const { out, problems } = resolveAll(unique)
  const text = render(out, read('NOTICE'))
  let failed = false
  if (problems.length) {
    console.error(`License policy (scripts/notices/policy.json):\n${[...new Set(problems)].sort().map((p) => '  - ' + p).join('\n')}`)
    failed = true
  }
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (current !== text) {
      console.error('THIRD_PARTY_NOTICES.md is stale: run `node scripts/notices/generate.mjs` and commit the result.')
      failed = true
    }
  } else {
    writeFileSync(OUT, text)
    console.log(`wrote THIRD_PARTY_NOTICES.md (${out.length} packages)`)
  }
  process.exit(failed ? 1 : 0)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1) })
