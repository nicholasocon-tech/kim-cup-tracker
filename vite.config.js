import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Replace 'kim-cup-tracker' with your actual GitHub repo name
export default defineConfig({
  plugins: [react()],
  base: '/kim-cup-tracker/',
})
