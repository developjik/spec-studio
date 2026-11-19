import { app, dialog, ipcMain, protocol } from 'electron';
import { DaemonManager, type DaemonSession } from './daemon';
import { desktopPaths } from './paths';
import { registerAppProtocol } from './protocol';
import { createMainWindow, getMainWindow } from './window';

/**
 * The desktop shell. Boot order: lock the single instance, reserve the app://
 * scheme, fork the daemon sidecar, then open the window over the web build.
 * `--smoke-*` flags run the same boot path headless and report JSON — that is
 * the D1 end-to-end check (start → use → restart → data still there).
 */

const SMOKE_MARKER = 'SMOKE_RESULT ';

type SmokePhase = 'create' | 'verify' | 'window';

function smokePhase(): SmokePhase | null {
  if (process.argv.includes('--smoke-create')) return 'create';
  if (process.argv.includes('--smoke-verify')) return 'verify';
  if (process.argv.includes('--smoke-window')) return 'window';
  return null;
}

const phase = smokePhase();
const smoke = phase !== null;

function flagValue(name: string): string | null {
  for (const argument of process.argv) {
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  }
  return null;
}

const userDataOverride = flagValue('--user-data');
if (userDataOverride !== null && userDataOverride !== '') app.setPath('userData', userDataOverride);

let manager: DaemonManager | null = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  void app
    .whenReady()
    .then(boot)
    .catch((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      if (smoke) {
        console.log(`${SMOKE_MARKER}${JSON.stringify({ phase, ok: false, error: message })}`);
        app.exit(1);
        return;
      }
      dialog.showErrorBox('spec-studio — 시작 실패', message);
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    void manager?.stop();
  });
}

async function boot(): Promise<void> {
  manager = new DaemonManager(desktopPaths());

  let session: DaemonSession | null = null;
  try {
    session = await manager.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (smoke) {
      console.log(`${SMOKE_MARKER}${JSON.stringify({ phase, ok: false, error: message })}`);
      app.exit(1);
      return;
    }
    // The window still opens — in browser fallback mode, like the web build.
    dialog.showErrorBox(
      'spec-studio — 데몬 시작 실패',
      `${message}\n\n브라우저 모드로 시작합니다. 데이터는 이 세션에만 저장됩니다.`,
    );
  }

  ipcMain.on('specstudio:info', (event) => {
    event.returnValue =
      session === null
        ? null
        : {
            daemonUrl: session.url,
            daemonToken: session.token,
            desktopVersion: app.getVersion(),
          };
  });

  registerAppProtocol(desktopPaths().webRoot);

  if (smoke && phase !== null) {
    await runSmoke(phase, manager, session);
    return;
  }

  createMainWindow();
  app.on('activate', () => {
    if (getMainWindow() === null) createMainWindow();
  });
}

async function runSmoke(
  phase: SmokePhase,
  manager: DaemonManager,
  session: DaemonSession | null,
): Promise<void> {
  if (session === null) {
    console.log(`${SMOKE_MARKER}${JSON.stringify({ phase, ok: false, error: 'no session' })}`);
    app.exit(1);
    return;
  }
  const headers = { 'content-type': 'application/json', 'x-daemon-token': session.token };

  try {
    if (phase === 'create') {
      const response = await fetch(`${session.url}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `desktop-smoke-${new Date().toISOString()}` }),
      });
      const body = (await response.json()) as { project?: { id?: string } };
      const ok = response.ok && typeof body.project?.id === 'string';
      console.log(
        `${SMOKE_MARKER}${JSON.stringify({
          phase,
          ok,
          projectId: body.project?.id ?? null,
          port: session.port,
        })}`,
      );
      await manager.stop();
      app.exit(ok ? 0 : 1);
      return;
    }

    if (phase === 'verify') {
      const response = await fetch(`${session.url}/api/projects`, { headers });
      const body = (await response.json()) as {
        projects?: Array<{ id: string; name: string }>;
      };
      const projects = body.projects ?? [];
      const persisted = projects.some((project) => project.name.startsWith('desktop-smoke-'));
      console.log(
        `${SMOKE_MARKER}${JSON.stringify({
          phase,
          ok: response.ok && persisted,
          persisted,
          projectCount: projects.length,
        })}`,
      );
      await manager.stop();
      app.exit(response.ok && persisted ? 0 : 1);
      return;
    }

    // window: the full renderer path — app:// page, preload bridge, CORS + token.
    const win = createMainWindow();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('window did not load')), 20_000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer);
        reject(new Error(`window load failed: ${code} ${description}`));
      });
    });
    const probe = (await win.webContents.executeJavaScript(
      `(() => {
        const info = window.specstudio && window.specstudio.getDaemonInfo();
        if (!info) return Promise.resolve({ bridge: false });
        return fetch(info.daemonUrl + '/api/health', { headers: { 'x-daemon-token': info.daemonToken } })
          .then((response) => ({ bridge: true, rendererHealth: response.ok }))
          .catch(() => ({ bridge: true, rendererHealth: false }));
      })()`,
    )) as { bridge: boolean; rendererHealth?: boolean };
    const ok = probe.bridge && probe.rendererHealth === true;
    console.log(
      `${SMOKE_MARKER}${JSON.stringify({ phase, ok, bridge: probe.bridge, rendererHealth: probe.rendererHealth === true })}`,
    );
    await manager.stop();
    app.exit(ok ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${SMOKE_MARKER}${JSON.stringify({ phase, ok: false, error: message })}`);
    await manager.stop();
    app.exit(1);
  }
}

