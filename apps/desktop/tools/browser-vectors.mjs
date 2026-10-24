// Runs the relay vectors (src/shared/relay-core/vectors.ts) in a real Chromium: builds tools/browser-vectors with Vite,
// serves it over loopback and reads the page's verdict. `npm run test:browser`. Needs Playwright's Chromium once:
//   npx playwright-core install chromium
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { build } from 'vite'

const root = resolve(import.meta.dirname, 'browser-vectors')
const out = mkdtempSync(join(tmpdir(), 'kith-browser-vectors-'))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }

let server
let browser
let failed = false
try {
  await build({ root, base: './', logLevel: 'warn', configFile: false, build: { outDir: out, emptyOutDir: true, target: 'es2022' } })
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    try {
      const file = join(out, path === '/' ? 'index.html' : path.replace(/\.\.+/g, ''))
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(readFileSync(file))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  browser = await chromium.launch()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.__vectors?.done, null, { timeout: 30_000 }).catch(() => {})
  const verdict = await page.evaluate(() => window.__vectors)
  console.log(`browser: Chromium ${browser.version()}`)
  if (!verdict) {
    console.error('the page never finished', errors)
    failed = true
  } else {
    for (const r of verdict.results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` (${r.error})` : ''}`)
    failed = verdict.results.some((r) => !r.ok) || verdict.results.length === 0
    console.log(`${verdict.results.filter((r) => r.ok).length}/${verdict.results.length} passed`)
  }
} finally {
  await browser?.close()
  server?.close()
  rmSync(out, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
