import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: '127.0.0.1' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // `node:sqlite` prints an experimental warning on first load; the adapter
    // is still the right choice — it is the SQLite the runtime already ships.
    fileParallelism: false,
  },
});
