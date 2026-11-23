import { defineConfig } from 'vitest/config';

// Bind to 127.0.0.1 rather than resolving "localhost": some sandboxed
// environments ship no /etc/hosts, and the tests need no network either way.
export default defineConfig({
  server: { host: '127.0.0.1' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
