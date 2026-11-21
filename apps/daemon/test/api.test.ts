import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { startMockConfluence, type MockConfluence } from '@spec-studio/publish/testing';
import { startDaemon, hostnameOf, isLoopbackHostname, type Daemon } from '../src/server';

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

/**
 * A request with a hand-written `Host`, which `fetch` will not let a caller set.
 * This is the only way to ask the daemon the question DNS rebinding asks.
 */
function rawRequest(
  target: Daemon,
  path: string,
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: target.port,
        path,
        method: 'GET',
        headers: host === undefined ? {} : { host },
        setHost: host !== undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

interface Envelope {
  project?: {
    id: string;
    pins: Array<{ id: string; number: number; title: string }>;
    screen: { id: string; figmaUrl?: string | null } | null;
    docs: Array<{
      id: string;
      rev: number;
      blocks: Array<{
        id: string;
        text: string;
        pinRefs: Array<{ pinId: string }>;
      }>;
    }>;
    proposals?: Array<{ id: string; state: string; summary: string; patches: unknown[] }>;
    graph?: {
      nodes: Array<{ id: string; type: string; title: string; state: string }>;
      links: Array<{ id: string; type: string; src: string; dst: string; suspectSince: string | null }>;
    };
    graphProposal?: { id: string; state: string; nodes: unknown[]; links: unknown[] } | null;
  };
  bundle?: {
    format: string;
    version: number;
    project: { id: string; graph: { nodes: Array<{ id: string }> } };
  };
  backup?: { path: string; bytes: number; at: string; projectId: string };
  opSeq?: number;
  revert?: { seq: number; summary: string; blocks: number; kind: string; nodes: number } | null;
  revertedSeq?: number;
  blocks?: number;
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
    expect(health.body).toMatchObject({ ok: true, schemaVersion: 15, mode: 'sqlite' });
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

  it('answers to the loopback names and nothing else', async () => {
    for (const host of [
      `127.0.0.1:${daemon.port}`,
      `localhost:${daemon.port}`,
      `[::1]:${daemon.port}`,
    ]) {
      const answer = await rawRequest(daemon, '/api/health', host);
      expect(answer.status).toBe(200);
    }
  });

  it('refuses a Host that a rebinding page would send, before reading any project', async () => {
    const answer = await rawRequest(daemon, '/api/projects', `evil.example:${daemon.port}`);
    expect(answer.status).toBe(403);
    expect((JSON.parse(answer.body) as Envelope).error?.code).toBe('host_not_allowed');
    expect(answer.body).not.toContain('projects');
  });

  it('refuses a request that names no host at all', async () => {
    // HTTP/1.1 without a Host header never reaches the handler: Node's parser
    // answers 400 first. Our own answer for a missing or unusable name is the
    // 403 path above, and the two helpers are asserted here directly.
    const answer = await rawRequest(daemon, '/api/projects');
    expect(answer.status).toBe(400);
    expect(answer.body).not.toContain('projects');
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('')).toBeNull();
    expect(isLoopbackHostname('evil.example')).toBe(false);
    expect(isLoopbackHostname('127.0.0.5')).toBe(true);
  });
});

describe('the import boundary', () => {
  it('refuses a bundle whose screen image is not an image this app embeds', async () => {
    const created = await api<Envelope>(daemon, '/api/projects', { body: { name: '주문 상세' } });
    const projectId = created.body.project?.id as string;
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'screen.attach', screen: SCREEN } },
    });
    const exported = await api<Envelope>(daemon, `/api/projects/${projectId}/export`);
    const bundle = exported.body.bundle as unknown as {
      project: { screen: { ref: { kind: string; value: string } } };
    };
    const screenshot = bundle.project.screen.ref.value;

    bundle.project.screen.ref.value = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    const refused = await api<Envelope>(daemon, '/api/projects/import', { body: { bundle } });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('invalid_bundle');

    bundle.project.screen.ref.value = 'data:image/png" onerror="alert(1);base64,AA==';
    const injected = await api<Envelope>(daemon, '/api/projects/import', { body: { bundle } });
    expect(injected.status).toBe(400);
    expect(injected.body.error?.code).toBe('invalid_bundle');

    // The same bundle with its ordinary screenshot still imports.
    bundle.project.screen.ref.value = screenshot;
    const accepted = await api<Envelope>(daemon, '/api/projects/import', { body: { bundle } });
    expect(accepted.status).toBe(201);
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

describe('W4: document ↔ pin, one proposal, op_log.before revert', () => {
  async function project(): Promise<string> {
    const created = await api<Envelope>(daemon, '/api/projects', { body: { name: '주문 상세 기획' } });
    const projectId = created.body.project?.id as string;
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'screen.attach', screen: SCREEN } },
    });
    for (const [title, pinType, body, x, y] of [
      ['취소 요청', 'function', '배송 준비 중일 때만 활성', 0.2, 0.3],
      ['배송 시작 후 취소 불가', 'policy', '사전조건: 배송 시작', 0.6, 0.5],
    ] as const) {
      await api(daemon, `/api/projects/${projectId}/commands`, {
        body: { command: { type: 'pin.create', screenId: SCREEN.id, pinType, title, body, anchor: { x, y } } },
      });
    }
    return projectId;
  }

  it('links a paragraph to a pin, marks it stale, adopts one card and reverts it', async () => {
    const projectId = await project();
    const opened = await api<Envelope>(daemon, `/api/projects/${projectId}`);
    const docId = opened.body.project?.docs[0]?.id as string;
    expect(opened.body.project?.docs[0]?.blocks).toEqual([]);
    expect(opened.body.revert).toBeNull();

    const added = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: {
        command: {
          type: 'doc.block.create',
          docId,
          blockType: 'paragraph',
          text: '배송이 시작되기 전까지만 취소할 수 있다.',
        },
      },
    });
    const blockId = added.body.project?.docs[0]?.blocks[0]?.id as string;
    const pinId = opened.body.project?.pins[0]?.id as string;

    const linked = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'doc.pin.link', docId, blockId, pinId } },
    });
    expect(linked.body.project?.docs[0]?.blocks[0]?.pinRefs).toHaveLength(1);
    expect(linked.body.project?.docs[0]?.blocks[0]?.text).toContain('[핀] #1 취소 요청');
    const originalText = linked.body.project?.docs[0]?.blocks[0]?.text as string;

    // a pin edit makes the paragraph stale; a move does not
    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'pin.update', screenId: SCREEN.id, pinId, anchor: { x: 0.3, y: 0.4 } } },
    });
    const moved = await api<Envelope>(daemon, `/api/projects/${projectId}`);
    expect(moved.body.project?.docs[0]?.blocks[0]?.text).toBe(originalText);

    await api(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'pin.update', screenId: SCREEN.id, pinId, title: '취소 요청 버튼' } },
    });

    // one proposal, one decision card
    const created = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'proposal.create', docId } },
    });
    const proposal = created.body.project?.proposals?.[0];
    expect(proposal?.state).toBe('open');
    expect(proposal?.patches).toHaveLength(1);
    expect(proposal?.summary).toContain('#1');

    const adopted = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'proposal.adopt', docId, proposalId: proposal?.id } },
    });
    expect(adopted.body.opSeq).toBeGreaterThan(0);
    expect(adopted.body.project?.docs[0]?.blocks[0]?.text).toContain('#1 취소 요청 버튼');
    expect(adopted.body.project?.proposals?.[0]?.state).toBe('adopted');

    const beforeRevert = await api<Envelope>(daemon, `/api/projects/${projectId}`);
    expect(beforeRevert.body.revert).toMatchObject({ seq: adopted.body.opSeq, blocks: 1 });

    // revert through op_log.before, from the file
    const reverted = await api<Envelope>(daemon, `/api/projects/${projectId}/revert`, {
      body: { seq: adopted.body.opSeq },
    });
    expect(reverted.status).toBe(200);
    expect(reverted.body.revertedSeq).toBe(adopted.body.opSeq);
    expect(reverted.body.project?.docs[0]?.blocks[0]?.text).toBe(originalText);
    expect(reverted.body.revert).toBeNull();

    // survives a restart: same blocks, same text, nothing left to undo
    await daemon.close();
    const reopened = await boot();
    const after = await api<Envelope>(reopened, `/api/projects/${projectId}`);
    expect(after.body.project?.docs[0]?.blocks[0]?.text).toBe(originalText);
    expect(after.body.project?.proposals?.[0]?.state).toBe('rejected');
    expect(after.body.revert).toBeNull();
  });

  it('refuses a revert when nothing was adopted', async () => {
    const projectId = await project();
    const response = await api<Envelope>(daemon, `/api/projects/${projectId}/revert`, {
      body: {},
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toContain('되돌릴');
  });
});

describe('v1: six node types, seven links, export/import and backup', () => {
  async function projectWithPins(): Promise<{ projectId: string; pinIds: string[] }> {
    const created = await api<Envelope>(daemon, '/api/projects', { body: { name: '취소 정책' } });
    const projectId = created.body.project?.id as string;
    await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
      body: { command: { type: 'screen.attach', screen: SCREEN } },
    });
    const pinIds: string[] = [];
    for (const [title, pinType, x] of [
      ['취소 요청', 'function', 0.2],
      ['배송 시작 후 취소 불가', 'policy', 0.45],
      ['재고 없음 안내', 'exception', 0.7],
    ] as const) {
      const result = await api<Envelope>(daemon, `/api/projects/${projectId}/commands`, {
        body: {
          command: {
            type: 'pin.create',
            screenId: SCREEN.id,
            pinType,
            title,
            body: '',
            anchor: { x, y: 0.4 },
          },
        },
      });
      pinIds.push(result.body.project!.pins.at(-1)!.id);
    }
    return { projectId, pinIds };
  }

  async function command(
    projectId: string,
    payload: unknown,
  ): Promise<{ status: number; body: Envelope }> {
    return api<Envelope>(daemon, `/api/projects/${projectId}/commands`, { body: { command: payload } });
  }

  it('stores the four graph kinds as obj rows and connects all seven link types', async () => {
    const { projectId, pinIds } = await projectWithPins();
    const req = await command(projectId, { type: 'node.create', nodeType: 'req', title: '취소 조건', body: '배송 전' });
    const reqId = req.body.project!.graph!.nodes[0]!.id;
    const policy = await command(projectId, { type: 'node.create', nodeType: 'policy', title: '배송 전만 취소', body: '' });
    const policyId = policy.body.project!.graph!.nodes[1]!.id;
    const contract = await command(projectId, { type: 'node.create', nodeType: 'contract', title: '취소 API', body: '' });
    const contractId = contract.body.project!.graph!.nodes[2]!.id;
    const qa = await command(projectId, { type: 'node.create', nodeType: 'qa', title: '취소 확인', body: '' });
    const qaId = qa.body.project!.graph!.nodes[3]!.id;

    expect(reqId.startsWith('N_')).toBe(true);
    expect(contractId.startsWith('C_')).toBe(true);
    expect(qaId.startsWith('V_')).toBe(true);

    const links: Array<[string, string, string]> = [
      ['implements', pinIds[0]!, reqId],
      ['governs', policyId, pinIds[0]!],
      ['handles_edge', pinIds[2]!, policyId],
      ['verifies', qaId, pinIds[0]!],
      ['references', reqId, qaId],
      ['derived_from', contractId, pinIds[0]!],
      ['blocks', qaId, reqId],
    ];
    for (const [linkType, src, dst] of links) {
      const result = await command(projectId, { type: 'link.create', linkType, src, dst });
      expect(result.status).toBe(200);
    }

    const read = await api<Envelope>(daemon, `/api/projects/${projectId}`);
    expect(read.body.project!.graph!.nodes).toHaveLength(4);
    expect(new Set(read.body.project!.graph!.links.map((link) => link.type)).size).toBe(7);

    const kinds = daemon.store.database
      .prepare("SELECT kind, subtype FROM obj WHERE id IN (?, ?, ?, ?)")
      .all(reqId, policyId, contractId, qaId) as Array<{ kind: string; subtype: string | null }>;
    expect(kinds).toEqual(
      expect.arrayContaining([
        { kind: 'specnode', subtype: 'requirement' },
        { kind: 'specnode', subtype: 'policy' },
        { kind: 'contract', subtype: 'api' },
        { kind: 'verification', subtype: null },
      ]),
    );

    const refused = await command(projectId, { type: 'link.create', linkType: 'implements', src: reqId, dst: pinIds[0]! });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('invalid_input');
  });

  it('turns pins into a decision card, adopts it, reverts it, and carries it through export/import', async () => {
    const { projectId } = await projectWithPins();
    const suggested = await command(projectId, { type: 'graph.proposal.create' });
    const card = suggested.body.project!.graphProposal!;
    expect(card.nodes.length).toBeGreaterThan(2);

    const adopted = await command(projectId, { type: 'graph.proposal.adopt', proposalId: card.id });
    expect(adopted.body.project!.graph!.nodes.length).toBe(card.nodes.length);
    expect(adopted.body.project!.graph!.links.length).toBe(card.links.length);
    const revertable = await api<Envelope>(daemon, `/api/projects/${projectId}`);
    expect(revertable.body.revert?.kind).toBe('graph');

    const paused = await api<Envelope>(daemon, `/api/projects/${projectId}/export`);
    expect(paused.body.bundle?.format).toBe('spec-studio.bundle');
    expect(paused.body.bundle!.project.graph.nodes.length).toBe(card.nodes.length);

    const imported = await api<Envelope>(daemon, '/api/projects/import', {
      body: { bundle: paused.body.bundle },
    });
    expect(imported.status).toBe(201);
    const importedId = imported.body.project!.id;
    expect(importedId).not.toBe(projectId);
    expect(imported.body.project!.graph!.nodes).toHaveLength(card.nodes.length);
    const originalIds = new Set(paused.body.bundle!.project.graph.nodes.map((node) => node.id));
    expect(imported.body.project!.graph!.nodes.every((node) => !originalIds.has(node.id))).toBe(true);

    const backup = await api<Envelope>(daemon, `/api/projects/${projectId}/backup`, { body: {} });
    expect(backup.status).toBe(200);
    expect(backup.body.backup!.bytes).toBeGreaterThan(0);
    expect(existsSync(backup.body.backup!.path)).toBe(true);

    const reverted = await api<Envelope>(daemon, `/api/projects/${projectId}/revert`, { body: {} });
    expect(reverted.status).toBe(200);
    expect(reverted.body.project!.graph!.nodes).toHaveLength(0);
    expect(reverted.body.project!.graphProposal?.state).toBe('reverted');
  });
});

describe('daemon session token (desktop shell)', () => {
  it('serves requests as before when no token is configured', async () => {
    const open = await boot();
    const response = await fetch(`${open.url}/api/health`);
    expect(response.status).toBe(200);
  });

  it('rejects a missing or wrong token with 401 and accepts the right one', async () => {
    const guarded = await startDaemon({
      dbPath: join(dir, 'guarded.db'),
      port: 0,
      authToken: 's3cret',
    });
    daemons.push(guarded);

    const missing = await fetch(`${guarded.url}/api/health`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: 'daemon_unauthorized' } });

    const wrong = await fetch(`${guarded.url}/api/health`, { headers: { 'x-daemon-token': 'nope' } });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${guarded.url}/api/health`, { headers: { 'x-daemon-token': 's3cret' } });
    expect(right.status).toBe(200);
  });

  it('answers preflight without a token so the browser can ask first', async () => {
    const guarded = await startDaemon({
      dbPath: join(dir, 'preflight.db'),
      port: 0,
      authToken: 's3cret',
      allowedOrigins: ['app://specstudio'],
    });
    daemons.push(guarded);

    const preflight = await fetch(`${guarded.url}/api/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'app://specstudio',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type, x-daemon-token',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('app://specstudio');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-daemon-token');
  });
});
