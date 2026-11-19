import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
});
