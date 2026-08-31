import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Vite would otherwise resolve the root from the working directory, which is
  // the repository root when this config is invoked from an npm script.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    // Built beside dist/server so Fastify can serve it as a sibling directory.
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    // Pinned because the Tauri shell points devUrl at this exact address;
    // letting Vite pick a fallback port would silently break `tauri dev`.
    port: 5173,
    strictPort: true,
    // `npm run dev:web` talks to a `npm run serve` on the default port.
    // /live must be proxied too, with ws:true, or dev mode renders a graph that
    // never updates.
    proxy: {
      '/api': 'http://127.0.0.1:4400',
      '/live': { target: 'ws://127.0.0.1:4400', ws: true },
    },
  },
});
