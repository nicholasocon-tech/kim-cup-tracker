import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served at the apex custom domain kim-cup.com, so assets live at the root.
// (Was '/kim-cup-tracker/' when hosted at the github.io project URL.)
export default defineConfig({
  plugins: [react()],
  base: '/',
})
