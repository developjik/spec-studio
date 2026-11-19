import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `VITE_BASE` moves the bundle under a sub-path (GitHub Pages serves this app
 * at `/spec-studio/`), while the default `/` keeps the local preview at
 * `http://127.0.0.1:4173/` and the Playwright E2E walk unchanged.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const base = env.VITE_BASE ?? '/';

  return {
    base,
    plugins: [react()],
    // Bind 127.0.0.1 rather than resolving "localhost": sandboxes without
    // /etc/hosts cannot resolve it, and the daemon's CORS list covers both.
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  };
});
