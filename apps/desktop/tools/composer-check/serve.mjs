import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const server = await createServer({
  configFile: false, root, plugins: [react()],
  resolve: { alias: { '@shared': `${root}src/shared` } },
  server: { host: '127.0.0.1', port: 5198, strictPort: true },
})
await server.listen()
console.log('Composer check: http://127.0.0.1:5198/tools/composer-check/')
