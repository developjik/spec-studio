import './bootstrap';
import { resolve } from 'node:path';
import { startDaemon, DEFAULT_ORIGINS, DEFAULT_PORT } from './server';

/**
 * Entry point for `pnpm start` / the bundle. The database path is a file on
 * this machine, set by the person running it; credentials never arrive here —
 * they are typed into the app and forwarded per publish request.
 */
const port = Number(process.env.SPEC_STUDIO_PORT ?? DEFAULT_PORT);
const dbPath = resolve(process.env.SPEC_STUDIO_DB ?? '.data/spec-studio.db');
const origins = (process.env.SPEC_STUDIO_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');

const daemon = await startDaemon({
  dbPath,
  port: Number.isFinite(port) ? port : DEFAULT_PORT,
  ...(origins.length === 0 ? {} : { allowedOrigins: origins }),
});

console.log(`spec-studio daemon · ${daemon.url} · db ${dbPath}`);
if (origins.length === 0) console.log(`allowed origins: ${DEFAULT_ORIGINS.join(', ')}`);

const shutdown = async (signal: string) => {
  console.log(`\n${signal} — closing`);
  await daemon.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
