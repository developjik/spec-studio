#!/usr/bin/env node
/**
 * D1 end-to-end check, in three sequential Electron boots over one throwaway
 * user-data directory:
 *
 *   create — boot, fork the daemon, create a project through the HTTP API
 *   verify — boot again, the project from `create` must still be there
 *   window — boot once more, load the real renderer, and prove the page can
 *            reach the daemon through the preload bridge (app:// + CORS + token)
 *
 * Each phase prints one `SMOKE_RESULT` JSON line; this script collects them,
 * prints a summary and exits non-zero on any failure. The window phase opens a
 * real window for a few seconds — that is the point of it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // the devDependency resolves to the binary path
const appDir = join(new URL('.', import.meta.url).pathname, '..');

const MARKER = 'SMOKE_RESULT ';
const userData = mkdtempSync(join(tmpdir(), 'specstudio-smoke-'));
const results = [];

function runPhase(flag) {
  const run = spawnSync(electronPath, [appDir, flag, `--user-data=${userData}`], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  const lines = (run.stdout ?? '').split('\n').filter((line) => line.startsWith(MARKER));
  const parsed = lines.length > 0 ? JSON.parse(lines[lines.length - 1].slice(MARKER.length)) : null;
  return {
    flag,
    result: parsed,
    stdout: (run.stdout ?? '').trim(),
    stderr: (run.stderr ?? '').trim(),
    status: run.status,
  };
}

try {
  for (const flag of ['--smoke-create', '--smoke-verify', '--smoke-window']) {
    const run = runPhase(flag);
    results.push(run);
    if (run.result === null || run.result.ok !== true) break; // later phases depend on earlier ones
  }
} finally {
  rmSync(userData, { recursive: true, force: true });
}

const summary = {
  ok: results.every((run) => run.result?.ok === true),
  phases: results.map((run) => ({
    phase: run.flag.replace('--smoke-', ''),
    ok: run.result?.ok === true,
    detail: run.result ?? { error: `no ${MARKER}line (exit ${run.status})` },
  })),
};

console.log('\n=== desktop smoke summary ===');
console.log(JSON.stringify(summary, null, 2));
for (const run of results) {
  if (run.stderr !== '' && run.result?.ok !== true) {
    console.error(`--- stderr (${run.flag}) ---\n${run.stderr}`);
  }
}
process.exit(summary.ok ? 0 : 1);
