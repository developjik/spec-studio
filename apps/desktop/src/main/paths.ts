import { app } from 'electron';
import { join } from 'node:path';

/**
 * Dev runs against workspace build output (`apps/daemon/dist`,
 * `apps/web/dist`); the packaged app carries both as extraResources next to
 * the asar, so the same code reads them off `process.resourcesPath`.
 */
export interface DesktopPaths {
  /** The daemon's bundled ESM entry, forked as a utility process. */
  entryPath: string;
  /** The web build the `app://` protocol serves. */
  webRoot: string;
  /** Electron's per-user data directory; the daemon's cwd. */
  userDataDir: string;
  /** The SQLite file — one per user, under userData. */
  dbPath: string;
}

export function desktopPaths(): DesktopPaths {
  const packaged = app.isPackaged;
  const entryPath = packaged
    ? join(process.resourcesPath, 'daemon', 'daemon.mjs')
    : join(__dirname, '..', '..', 'daemon', 'dist', 'daemon.mjs');
  const webRoot = packaged
    ? join(process.resourcesPath, 'web')
    : join(__dirname, '..', '..', 'web', 'dist');
  const userDataDir = app.getPath('userData');
  return { entryPath, webRoot, userDataDir, dbPath: join(userDataDir, 'spec-studio.db') };
}
