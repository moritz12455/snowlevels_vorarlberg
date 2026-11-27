import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Im Dev-Modus werden /api-Aufrufe an das Go-Backend weitergeleitet.
const backend = process.env.API_URL || 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
    },
  },
})
