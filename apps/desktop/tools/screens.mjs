// Screenshots the dev galleries (tokens.html, components.html) with headless Chromium, for CI
// (.github/workflows/screens.yml): each at 1280 wide and at the 260 px sidebar (?narrow), light and dark.
// Playwright is not a dependency: the job installs it with `npm i --no-save playwright`.
// Usage (from apps/desktop): node tools/screens.mjs <out-dir>
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const out = resolve(process.argv[2] ?? 'screens')
mkdirSync(out, { recursive: true })
const port = 5199
const base = `http://localhost:${port}`

const vite = spawn('npx', ['vite', '--config', 'vite.tokens.config.ts', '--port', String(port), '--strictPort'], { stdio: 'inherit' })
const stop = () => vite.kill()
process.on('exit', stop)

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/tokens.html`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('vite did not start')
}

const pages = [
  { name: 'tokens', path: '/tokens.html', widths: { wide: 1280 } },
  { name: 'components', path: '/components.html', widths: { wide: 1280, narrow: 260 } },
]

try {
  await waitForServer()
  const browser = await chromium.launch()
  for (const scheme of ['light', 'dark']) {
    for (const p of pages) {
      for (const [label, width] of Object.entries(p.widths)) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })
        const page = await ctx.newPage()
        await page.goto(`${base}${p.path}${label === 'narrow' ? '?narrow' : ''}`, { waitUntil: 'networkidle' })
        await page.evaluate(() => document.fonts.ready)
        // The gallery scrolls inside #root, so grow the viewport to the content to capture all of it.
        const height = await page.evaluate(() => document.getElementById('root')?.firstElementChild?.scrollHeight ?? 900)
        await page.setViewportSize({ width, height: Math.min(Math.max(height, 900), 16000) })
        await page.screenshot({ path: `${out}/desktop-${p.name}-${label}-${scheme}.png` })
        await ctx.close()
      }
    }
  }
  await browser.close()
} finally {
  stop()
}
