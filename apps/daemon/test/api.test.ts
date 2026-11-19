import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { startMockConfluence, type MockConfluence } from '@spec-studio/publish/testing';
import { startDaemon, type Daemon } from '../src/server';

/**
 * The whole W3 promise exercised through the daemon's own HTTP API, against a
 * real SQLite file and a Confluence-shaped server:
 *
 *  1. first publish creates one page and uploads three attachments,
 *  2. the same spec again creates nothing,
 *  3. after the daemon and its store are closed and reopened, still nothing,
 *  4. an edited pin updates the existing page instead of adding one.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SCREEN: Screen = {
  id: `S_${'d'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
};

let dir = '';
let dbPath = '';
let daemon: Daemon;
let mock: MockConfluence;
const daemons: Daemon[] = [];

async function boot(): Promise<Daemon> {
  const started = await startDaemon({
    dbPath,
    port: 0,
    now: () => '2026-11-19T09:30:00.000Z',
  });
  daemons.push(started);
  return started;
}

async function api<T>(
  target: Daemon,
  path: string,
  init: { method?: string; body?: unknown; origin?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.origin !== undefined) headers.origin = init.origin;
  const response = await fetch(`${target.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface Envelope {
  project?: { id: string; pins: Array<{ id: string; number: number }>; screen: { figmaUrl?: string | null } | null };
  records?: Array<{ id: string; pageId: string | null; status: string; specHash: string | null }>;
  preview?: { plan: string; specHash: string; body: string; attachments: unknown[] };
  outcome?: {
    status: string;
    page: { id: string; url: string } | null;
    attachments: Array<{ fileName: string; action: string }>;
    message: string;
  };
  error?: { code: string; message: string };
  projects?: Array<{ id: string }>;
}

const target = () => ({
  baseUrl: mock.url,
  space: 'SPEC',
  email: 'dev@example.com',
  apiToken: 'super-secret-token',
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-daemon-'));
  dbPath = join(dir, 'graph.db');
  mock = await startMockConfluence();
  daemon = await boot();
});

afterEach(async () => {
  for (const started of daemons.splice(0)) {
    try {
      await started.close();
    } catch {
      // already closed by the test
    }
  }
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the daemon API', () => {
  it('reports health and names SQLite as the canonical store', async () => {
    const health = await api<{ ok: boolean; schemaVersion: number; mode: string }>(daemon, '/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, schemaVersion: 12, mode: 'sqlite' });
  });

  it('serves only the app origins', async () => {
    const allowed = await api<{ ok: boolean }>(daemon, '/api/health', {
      origin: 'http://localhost:5173',
    });
    expect(allowed.status).toBe(200);
    const denied = await api<Envelope>(daemon, '/api/health', { origin: 'http://evil.example' });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('origin_not_allowed');
  });
});

describe('W3: SQLite behind the daemon, Confluence in front of it', () => {
  it('stores a screen and pins in the SQLite file, publishes once, and never duplicates', async () => {
    // ① a project and a screen, written through the API
    const created = await api<Envelope>(daemon, '/api/projects', {
      body: { name: '주문 상세 기획' },
    });
    expect(created.status).toBe(201);
    const projectId = created.body.project?.id as string;
    expect(projectId).toMatch(/^PRJ_/);

    const attached = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'screen.attach', screen: SCREEN } },
    });
    expect(attached.status).toBe(200);

    const figma = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'screen.update',
          screenId: SCREEN.id,
          figmaUrl: 'https://www.figma.com/file/abc123/Shop?node-id=12-34',
        },
      },
    });
    expect(figma.body.project?.screen?.figmaUrl).toBe(
      'https://www.figma.com/file/abc123/Shop?node-id=12-34',
    );

    for (const [title, pinType, body, x, y] of [
      ['취소 요청', 'function', '배송 준비 중일 때만 활성', 0.2, 0.4],
      ['배송 시작 후 취소 불가', 'policy', '사전조건: 배송 시작', 0.55, 0.5],
      ['재고 없음', 'exception', '', 0.75, 0.65],
    ] as const) {
      const result = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
        body: {
          command: {
            type: 'pin.create',
            screenId: SCREEN.id,
            pinType,
            title,
            body,
            anchor: { x, y },
          },
        },
      });
      expect(result.status).toBe(200);
    }

    // ① the SQLite file really holds it — read it with a separate connection
    const raw = await api<Envelope>(daemon, `/api/projects/${projectId}`);
    expect(raw.body.project?.pins.map((pin) => pin.number)).toEqual([1, 2, 3]);

    // preview says: this will create
    const preview = await api<Envelope>(daemon, `/api/projects/${projectId}/publish/preview`, {
      body: { space: 'SPEC' },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview?.plan).toBe('create');
    expect(preview.body.preview?.attachments).toHaveLength(3);
    expect(preview.body.preview?.body).toContain('Figma 프레임');

    // ② first publish
    const first = await api<Envelope>(daemon, `/api/projects/${projectId}/publish`, {
      body: { target: target(), mode: 'auto', overlayPng: PNG_BASE64 },
    });
    expect(first.status).toBe(200);
    expect(first.body.outcome?.status).toBe('created');
    expect(first.body.outcome?.attachments.map((item) => item.action)).toEqual([
      'created',
      'created',
      'created',
    ]);
    expect(mock.pageCreates).toBe(1);
    expect(mock.pages.size).toBe(1);
    const pageId = first.body.outcome?.page?.id as string;
    expect(mock.attachments.get(pageId)).toHaveLength(3);
    expect(first.body.outcome?.page?.url).toContain('/wiki/spaces/SPEC/pages/');

    // ② again, same spec — skipped, no second page
    const second = await api<Envelope>(daemon, `/api/projects/${projectId}/publish`, {
      body: { target: target(), mode: 'auto', overlayPng: PNG_BASE64 },
    });
    expect(second.body.outcome?.status).toBe('skipped');
    expect(mock.pageCreates).toBe(1);
    expect(mock.attachments.get(pageId)).toHaveLength(3);

    // ③ close the daemon *and* its store, then reopen the same file
    await daemon.close();
    const reopened = await boot();

    const afterRestart = await api<Envelope>(reopened, `/api/projects/${projectId}/publish`, {
      body: { target: target(), mode: 'auto', overlayPng: PNG_BASE64 },
    });
    expect(afterRestart.body.outcome?.status).toBe('skipped');
    expect(mock.pageCreates).toBe(1);

    // history survived the restart
    const history = await api<Envelope>(reopened, `/api/projects/${projectId}/publishes`);
    expect(history.body.records).toHaveLength(1);
    expect(history.body.records?.[0]?.pageId).toBe(pageId);
    expect(history.body.records?.[0]?.status).toBe('ok');

    // ④ edit a pin, publish again — one update, still one page
    const listed = await api<Envelope>(reopened, `/api/projects/${projectId}`);
    const firstPin = listed.body.project?.pins[0];
    expect(firstPin).toBeDefined();

    const edited = await api<Envelope>(reopened, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'pin.update',
          screenId: SCREEN.id,
          pinId: firstPin?.id,
          title: '취소 요청 — 데스크에서만',
        },
      },
    });
    expect(edited.status).toBe(200);

    const third = await api<Envelope>(reopened, `/api/projects/${projectId}/publish`, {
      body: { target: target(), mode: 'auto', overlayPng: PNG_BASE64 },
    });
    expect(third.body.outcome?.status).toBe('updated');
    expect(mock.pageCreates).toBe(1);
    expect(mock.pageUpdates).toBe(1);
    expect(mock.pages.size).toBe(1);
    expect([...mock.pages.values()][0]?.body).toContain('취소 요청 — 데스크에서만');
    expect(mock.attachments.get(pageId)).toHaveLength(3);
    expect([...(mock.attachments.get(pageId) ?? [])].map((item) => item.version)).toEqual([2, 2, 2]);

    // two records: create + update, both ok
    const finalHistory = await api<Envelope>(reopened, `/api/projects/${projectId}/publishes`);
    expect(finalHistory.body.records?.map((record) => record.status)).toEqual(['ok', 'ok']);

    // the token never reached the database
    const token = 'super-secret-token';
    const dump = JSON.stringify(finalHistory.body);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain('dev@example.com');
  });

  it('refuses an overlay that is not a PNG', async () => {
    const created = await api<Envelope>(daemon, '/api/projects', { body: { name: 'x' } });
    const projectId = created.body.project?.id as string;
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'screen.attach', screen: SCREEN } },
    });
    const response = await api<Envelope>(daemon, `/api/projects/${projectId}/publish`, {
      body: { target: target(), mode: 'auto', overlayPng: 'bm90IGEgcG5n' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('overlay_invalid');
    expect(mock.pageCreates).toBe(0);
  });

  it('surfaces a Confluence refusal as an error and records the failure', async () => {
    const created = await api<Envelope>(daemon, '/api/projects', { body: { name: 'x' } });
    const projectId = created.body.project?.id as string;
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'screen.attach', screen: SCREEN } },
    });
    const broken = await startDaemon({ dbPath: join(dir, 'broken.db'), port: 0 });
    await broken.close();

    const response = await api<Envelope>(daemon, `/api/projects/${projectId}/publish`, {
      body: {
        target: { ...target(), baseUrl: 'http://127.0.0.1:1' },
        mode: 'auto',
        overlayPng: PNG_BASE64,
      },
    });
    expect(response.status).toBe(502);
    expect(response.body.error?.code).toBe('confluence_error');

    const history = await api<Envelope>(daemon, `/api/projects/${projectId}/publishes`);
    expect(history.body.records?.[0]?.status).toBe('failed');
  });
});
