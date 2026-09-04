import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const shared = fileURLToPath(new URL('./shared', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': shared },
  },
  server: {
    proxy: {
      // The run server. SSE needs the proxy to leave the connection open.
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
})
