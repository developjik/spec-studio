import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * `core-is-pure` is enforced two ways: dependency-cruiser blocks I/O imports,
 * and this test blocks the clock and randomness, which no import graph sees.
 */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'fs import', pattern: /from\s+['"](?:node:)?fs(?:\/promises)?['"]/ },
  { name: 'http import', pattern: /from\s+['"](?:node:)?https?['"]/ },
  { name: 'net import', pattern: /from\s+['"](?:node:)?(?:net|child_process)['"]/ },
  { name: 'Date.now()', pattern: /\bDate\.now\s*\(/ },
  { name: 'new Date()', pattern: /new\s+Date\s*\(\s*\)/ },
  { name: 'Math.random()', pattern: /\bMath\.random\s*\(/ },
  { name: 'fetch()', pattern: /(^|[^.\w])fetch\s*\(/ },
  { name: 'process', pattern: /\bprocess\./ },
];

describe('core purity', () => {
  it('never reaches for the clock, randomness or I/O', async () => {
    const files = (await readdir(SRC)).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const file of files) {
      const text = await readFile(join(SRC, file), 'utf8');
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(text)) offences.push(`${file}: ${rule.name}`);
      }
    }

    expect(offences).toEqual([]);
  });
});
