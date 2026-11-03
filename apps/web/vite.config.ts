import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API serves the build from apps/api/web (see routes/web.ts there). In
// development, Vite proxies the API so the session cookie stays same-origin.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['development'] },
  // `/assets/` is the API's invite and reset pages.
  build: { outDir: '../api/web', emptyOutDir: true, sourcemap: true, assetsDir: 'static' },
  server: {
    port: 5173,
    proxy: {
      '/v1': process.env.API_URL ?? 'http://localhost:8080',
      '/accept-invite': process.env.API_URL ?? 'http://localhost:8080',
      '/reset-password': process.env.API_URL ?? 'http://localhost:8080',
      '/assets': process.env.API_URL ?? 'http://localhost:8080',
    },
  },
});
