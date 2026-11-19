import { dialog, net, utilityProcess, type UtilityProcess } from 'electron';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DesktopPaths } from './paths';

/**
 * The daemon runs as a utility process — the same single-file bundle
 * `pnpm daemon` starts, over the same HTTP API. The shell picks a free port,
 * mints a one-shot session token, and hands both to the renderer; the daemon
 * answers nothing without the token, so a local process that merely knows the
 * port gets a 401.
 */

export interface DaemonSession {
  readonly url: string;
  readonly port: number;
  readonly token: string;
}

const MAX_RESTARTS = 5;
const HEALTH_TIMEOUT_MS = 20_000;
const STDERR_TAIL_LINES = 40;

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DaemonManager {
  readonly paths: DesktopPaths;

  #child: UtilityProcess | null = null;
  #session: DaemonSession | null = null;
  #stderrTail: string[] = [];
  #quitting = false;
  #restarts = 0;

  constructor(paths: DesktopPaths) {
    this.paths = paths;
  }

  get session(): DaemonSession | null {
    return this.#session;
  }

  async start(): Promise<DaemonSession> {
    this.#quitting = false;
    this.#restarts = 0;
    const port = await findFreePort();
    const token = randomBytes(32).toString('hex');
    this.#session = { url: `http://127.0.0.1:${port}`, port, token };
    this.#fork();
    await this.#waitHealthy();
    return this.#session;
  }

  async stop(): Promise<void> {
    this.#quitting = true;
    const child = this.#child;
    if (child === null) return;
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 2000);
      child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
      child.kill();
    });
    this.#child = null;
  }

  #fork(): void {
    const session = this.#session;
    if (session === null) return;
    mkdirSync(dirname(this.paths.dbPath), { recursive: true });
    this.#stderrTail = [];

    const child = utilityProcess.fork(this.paths.entryPath, [], {
      serviceName: 'spec-studio-daemon',
      stdio: 'pipe',
      cwd: this.paths.userDataDir,
      env: {
        ...process.env,
        SPEC_STUDIO_PORT: String(session.port),
        SPEC_STUDIO_DB: this.paths.dbPath,
        SPEC_STUDIO_ORIGINS: 'app://specstudio',
        SPEC_STUDIO_TOKEN: session.token,
      },
    });
    this.#child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[daemon] ${String(chunk)}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      process.stderr.write(`[daemon] ${text}`);
      this.#stderrTail.push(text);
      if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
    });

    child.on('exit', (code) => {
      if (this.#quitting || this.#child !== child) return;
      if (this.#restarts >= MAX_RESTARTS) {
        dialog.showErrorBox(
          'spec-studio — 데몬 재시동 실패',
          `데몬이 ${MAX_RESTARTS}번 재시동되었지만 계속 종료됩니다.\n\n${this.#stderrTailText()}`,
        );
        return;
      }
      this.#restarts += 1;
      const delay = Math.min(500 * 2 ** (this.#restarts - 1), 8000);
      setTimeout(
        () => {
          if (this.#quitting || this.#child !== child) return;
          console.log(`[daemon] exited (${code}) — restarting ${this.#restarts}/${MAX_RESTARTS}`);
          this.#fork();
        },
        delay,
      );
    });
  }

  async #waitHealthy(): Promise<void> {
    const session = this.#session;
    if (session === null) throw new Error('데몬 세션이 없습니다.');
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let last = '시간 초과 전에 데몬이 종료되었습니다.';
    while (Date.now() < deadline) {
      if (this.#child === null) break;
      try {
        const response = await net.fetch(`${session.url}/api/health`, {
          headers: { 'x-daemon-token': session.token },
          signal: AbortSignal.timeout(1500),
        });
        // /api/health touches SQLite, so ok === the node:sqlite smoke passed.
        if (response.ok) return;
        last = `health ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(200);
    }
    throw new Error(`데몬이 준비되지 않았습니다 (${last}).\n${this.#stderrTailText()}`);
  }

  #stderrTailText(): string {
    return this.#stderrTail.join('').trim().slice(-1200);
  }
}
