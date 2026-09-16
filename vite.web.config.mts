import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = dirname(fileURLToPath(import.meta.url))

// browser build of the desktop renderer, served by the StemKit web server
// (src/server). `npm run web:dev` proxies the API to a server on :8080
export default defineConfig({
  root: resolve(root, 'src/web'),
  publicDir: resolve(root, 'build'),
  plugins: [react(), tailwindcss()],
  resolve: {
    // the renderer entry imports './index.css'; swap in the web stylesheet,
    // which wraps it (see src/web/app.css)
    alias: [{ find: /^\.\/index\.css$/, replacement: resolve(root, 'src/web/app.css') }]
  },
  build: {
    outDir: resolve(root, 'out/web'),
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/healthz': 'http://localhost:8080'
    }
  }
})
