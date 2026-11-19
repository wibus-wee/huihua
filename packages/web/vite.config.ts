import { defineConfig } from 'vite'

// Vite 8 compiles JSX through oxc; no React plugin is required for a simple SPA.
export default defineConfig({
  build: { target: 'es2023' },
})
