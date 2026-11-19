import { cpSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

/**
 * The daemon ships as one bundled ESM file. The workspace packages are consumed
 * as TypeScript sources, so a plain `tsc` emit would leave imports pointing at
 * files Node cannot load; esbuild resolves and inlines them, and keeps the
 * `node:` built-ins external.
 */
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/daemon.mjs',
  sourcemap: true,
  external: ['node:*'],
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// The DDL is read from disk at runtime, so it travels beside the bundle.
mkdirSync('dist/schema', { recursive: true });
cpSync('../../packages/store/schema', 'dist/schema', { recursive: true });

