import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

/**
 * The eval runner bundles like the daemon does: the workspace packages are
 * consumed as TypeScript sources, so esbuild resolves them and produces one
 * ESM file Node can run. `eval/dist` is scratch output and never committed.
 */
mkdirSync('eval/dist', { recursive: true });

await build({
  entryPoints: ['eval/src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'eval/dist/eval.mjs',
  external: ['node:*'],
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});
