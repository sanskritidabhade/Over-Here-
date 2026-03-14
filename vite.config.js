import { defineConfig } from 'vite'
import restart from 'vite-plugin-restart'
import glsl from 'vite-plugin-glsl'

export default defineConfig({
  root: './',
  publicDir: './public/',
  base: './',
  server: {
    host: true, // accessible sur le réseau local
    open: !('SANDBOX_URL' in process.env || 'CODESANDBOX_HOST' in process.env)
  },
  build: {
    outDir: 'dist', // doit pointer vers un dossier local (pas ../dist)
    emptyOutDir: true,
    sourcemap: true
  },
  plugins: [
    restart({ restart: ['public/**'] }),
    glsl()
  ]
})
