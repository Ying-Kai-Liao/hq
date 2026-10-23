import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev only (`npm run tokens`): the design-token gallery at /tokens.html, outside the Electron build.
export default defineConfig({
  root: resolve('src/renderer/dev'),
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()],
  server: { fs: { allow: [resolve('../..')] } },
})
