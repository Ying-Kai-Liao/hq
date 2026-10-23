import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The website's live demo: the renderer on an in-memory host (src/renderer/demo), served by
// web/ at /demo/desktop/. Separate from the Electron build (electron.vite.config.ts).
// The website is dark: the demo always uses the app's dark palette (bridge.ts answers matchMedia).
const alwaysDark: Plugin = {
  name: 'kith-demo-dark',
  enforce: 'pre',
  // theme.css @imports tokens.css, which the bundler resolves after this runs, so it is inlined here to get the same rewrite.
  transform: (code, id) => {
    if (!id.endsWith('.css')) return null
    const full = id.endsWith('styles/theme.css') ? code.replace("@import './tokens.css';", readFileSync(resolve('src/renderer/styles/tokens.css'), 'utf8')) : code
    return full.replaceAll('@media (prefers-color-scheme: dark)', '@media all')
  },
}

export default defineConfig({
  root: resolve('src/renderer/demo'),
  publicDir: resolve('src/renderer/public'),
  // Absolute, so assets resolve however the host serves the page (folder URL or index.html).
  base: '/demo/desktop/',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react(), alwaysDark],
  build: { outDir: resolve('../../web/public/demo/desktop'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
