import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The website's live demo: the renderer on an in-memory host (src/renderer/demo), served by
// web/ at /demo/desktop/. Separate from the Electron build (electron.vite.config.ts).
// The website is dark: the demo always uses the app's dark palette (bridge.ts answers matchMedia).
const alwaysDark: Plugin = {
  name: 'codync-demo-dark',
  enforce: 'pre',
  transform: (code, id) => (id.endsWith('.css') ? code.replaceAll('@media (prefers-color-scheme: dark)', '@media all') : null),
}

export default defineConfig({
  root: resolve('src/renderer/demo'),
  publicDir: resolve('src/renderer/public'),
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react(), alwaysDark],
  build: { outDir: resolve('../../web/public/demo/desktop'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
