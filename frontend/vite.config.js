import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Reines Frontend: die Daten kommen direkt von GeoSphere Austria und Open-Meteo.
export default defineConfig({
  plugins: [react()],
})
