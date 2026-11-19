import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundle ships `schema/` beside `daemon.mjs`. Point the store at that copy
 * before any module reads `SCHEMA_FILE`; run from source, the store's own
 * default applies.
 */
if (process.env.SPEC_STUDIO_SCHEMA_DIR === undefined) {
  process.env.SPEC_STUDIO_SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'schema');
}
