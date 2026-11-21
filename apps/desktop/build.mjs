import { build } from 'esbuild';

/**
 * The desktop ships as two small CommonJS bundles — the same shape the daemon
 * uses, and the only form a sandboxed preload may take. Electron and the
 * `node:` built-ins stay external; there are no other runtime dependencies.
 */
await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/main.cjs',
  sourcemap: true,
  external: ['electron', 'node:*'],
  logLevel: 'info',
});

await build({
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/preload.cjs',
  sourcemap: true,
  external: ['electron', 'node:*'],
  logLevel: 'info',
});
