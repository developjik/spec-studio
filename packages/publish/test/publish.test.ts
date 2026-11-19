import { beforeEach, describe, expect, it } from 'vitest';
import type { Pin, Screen } from '@spec-studio/protocol';
import {
  buildPublishPackage,
  previewPublish,
  publishSpec,
  PublishError,
  type PublishRecordPort,
  type PublishRecordSaveInput,
  type PublishRecordSnapshot,
} from '../src';
import { startMockConfluence, type MockConfluence } from '../src/testing/mock-confluence';

const SCREEN: Screen = {
  id: `S_${'c'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  figmaUrl: 'https://www.figma.com/file/abc123/Shop?node-id=12-34',
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
};

const PINS: Pin[] = [
  {
    id: `P_${'1'.repeat(12)}`,
    screenId: SCREEN.id,
    number: 1,
    type: 'function',
    title: '취소 요청',
    body: '배송 준비 중일 때만 활성',
    anchor: { x: 0.2, y: 0.4 },
    createdAt: '2026-11-19T09:00:00.000Z',
    updatedAt: '2026-11-19T09:00:00.000Z',
  },
  {
    id: `P_${'3'.repeat(12)}`,
    screenId: SCREEN.id,
    number: 3,
    type: 'policy',
    title: '배송 시작 후 취소 불가',
    body: '사전조건: 배송 시작',
    anchor: { x: 0.6, y: 0.5 },
    createdAt: '2026-11-19T09:00:00.000Z',
    updatedAt: '2026-11-19T09:00:00.000Z',
  },
];

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

class MemoryRecords implements PublishRecordPort {
  readonly rows = new Map<string, PublishRecordSnapshot>();

  async findBySpec(input: {
    projectId: string;
    target: 'confluence';
    spaceKey: string;
    specHash: string;
  }): Promise<PublishRecordSnapshot | null> {
    const matches = [...this.rows.values()].filter(
      (row) =>
        row.specHash === input.specHash &&
        row.spaceKey === input.spaceKey &&
        row.status === 'ok',
    );
    return matches.at(-1) ?? null;
  }

  async findLatest(input: {
    projectId: string;
    target: 'confluence';
    spaceKey: string;
  }): Promise<PublishRecordSnapshot | null> {
    const matches = [...this.rows.values()].filter(
      (row) => row.spaceKey === input.spaceKey && row.status === 'ok' && row.pageId !== null,
    );
    return matches.at(-1) ?? null;
  }

  async save(input: PublishRecordSaveInput): Promise<PublishRecordSnapshot> {
    const existing = this.rows.get(input.idemKey);
    const row: PublishRecordSnapshot = {
      id: existing?.id ?? `PB_${String(this.rows.size + 1).padStart(12, '0')}`,
      pageId: input.pageId,
      remoteUrl: input.remoteUrl,
      specHash: input.specHash,
      spaceKey: input.spaceKey,
      publishedAt: input.publishedAt,
      status: input.status,
    };
    this.rows.set(input.idemKey, row);
    return row;
  }
}

function run(
  overrides: Partial<Parameters<typeof publishSpec>[0]> = {},
): Parameters<typeof publishSpec>[0] {
  return {
    projectId: 'PRJ_abcdefghijkl',
    projectName: '주문 상세 기획',
    screen: SCREEN,
    pins: PINS,
    pinSeq: 3,
    figmaUrl: SCREEN.figmaUrl ?? null,
    generatedAt: '2026-11-19T09:30:00.000Z',
    mode: 'auto',
    overlayPng: PNG,
    target: {
      baseUrl: '',
      space: 'SPEC',
      email: 'dev@example.com',
      apiToken: 'token-value',
    },
    ...overrides,
  };
}

let mock: MockConfluence;

beforeEach(async () => {
  mock = await startMockConfluence();
});

describe('the published body', () => {
  it('carries the screen summary, the Figma link, the three tables and the gap notice', () => {
    const pkg = buildPublishPackage({
      projectName: '주문 상세 기획',
      screen: SCREEN,
      pins: PINS,
      pinSeq: 3,
      figmaUrl: SCREEN.figmaUrl ?? null,
      generatedAt: '2026-11-19T09:30:00.000Z',
      overlayPng: PNG,
    });

    expect(pkg.title).toBe('[spec-studio] 주문 상세');
    expect(pkg.body).toContain('로컬 정본에서 단방향으로 복사한 화면설계서');
    expect(pkg.body).toContain('https://www.figma.com/file/abc123/Shop?node-id=12-34');
    expect(pkg.body).toContain('기능 표');
    expect(pkg.body).toContain('정책 표');
    expect(pkg.body).toContain('예외 표');
    expect(pkg.body).toContain('#2');
    expect(pkg.body).toContain('spec-studio-scr-110-overlay.png');
    expect(pkg.body).toContain('spec-studio-scr-110-qa.csv');
    expect(pkg.attachments.map((attachment) => attachment.kind)).toEqual([
      'overlay-png',
      'spec-html',
      'qa-csv',
    ]);
  });

  it('escapes markup in a pin title instead of letting it into the page', () => {
    const hostile: Pin = { ...(PINS[0] as Pin), title: '<script>alert(1)</script>' };
    const pkg = buildPublishPackage({
      projectName: '주문 상세 기획',
      screen: SCREEN,
      pins: [hostile],
      pinSeq: 1,
      figmaUrl: null,
      generatedAt: '2026-11-19T09:30:00.000Z',
      overlayPng: PNG,
    });
    expect(pkg.body).toContain('&lt;script&gt;');
    expect(pkg.body).not.toContain('<script>');
  });

  it('omits the Figma section when no frame is registered', () => {
    const pkg = buildPublishPackage({
      projectName: '주문 상세 기획',
      screen: SCREEN,
      pins: PINS,
      pinSeq: 3,
      figmaUrl: null,
      generatedAt: '2026-11-19T09:30:00.000Z',
      overlayPng: PNG,
    });
    expect(pkg.body).not.toContain('Figma 프레임');
  });
});

describe('publishing to Confluence', () => {
  it('creates one page and uploads the three attachments', async () => {
    const records = new MemoryRecords();
    const outcome = await publishSpec(
      run({
        target: {
          baseUrl: mock.url,
          space: 'SPEC',
          email: 'dev@example.com',
          apiToken: 'token-value',
        },
      }),
      { records },
    );

    expect(outcome.status).toBe('created');
    expect(outcome.attachments.map((item) => item.action)).toEqual(['created', 'created', 'created']);
    expect(mock.pageCreates).toBe(1);
    expect(mock.pages.size).toBe(1);
    const page = [...mock.pages.values()][0];
    expect(page?.title).toBe('[spec-studio] 주문 상세');
    expect(page?.body).toContain('Figma 프레임');
    expect(mock.attachments.get(page?.id ?? '')).toHaveLength(3);
    expect(mock.requests.every((request) => request.authorized)).toBe(true);
    expect(outcome.page?.url).toContain('/wiki/spaces/SPEC/pages/');
    expect(records.rows.size).toBe(1);
  });

  it('publishing the same spec again makes no second page', async () => {
    const records = new MemoryRecords();
    const base = run({
      target: {
        baseUrl: mock.url,
        space: 'SPEC',
        email: 'dev@example.com',
        apiToken: 'token-value',
      },
    });
    await publishSpec(base, { records });
    const again = await publishSpec(base, { records });

    expect(again.status).toBe('skipped');
    expect(again.message).toContain('새 페이지를 만들지 않았습니다');
    expect(mock.pageCreates).toBe(1);
    expect(mock.attachments.size).toBe(1);
  });

  it('updates the existing page when a pin changes', async () => {
    const records = new MemoryRecords();
    const base = run({
      target: {
        baseUrl: mock.url,
        space: 'SPEC',
        email: 'dev@example.com',
        apiToken: 'token-value',
      },
    });
    await publishSpec(base, { records });

    const edited = { ...(PINS[0] as Pin), title: '취소 요청 — 데스크에서만' };
    const outcome = await publishSpec(
      { ...base, pins: [edited, PINS[1] as Pin], generatedAt: '2026-11-19T10:00:00.000Z' },
      { records },
    );

    expect(outcome.status).toBe('updated');
    expect(mock.pageCreates).toBe(1);
    expect(mock.pageUpdates).toBe(1);
    expect(mock.pages.size).toBe(1);
    const page = [...mock.pages.values()][0];
    expect(page?.version).toBe(2);
    expect(page?.body).toContain('취소 요청 — 데스크에서만');
    expect(mock.attachments.get(page?.id ?? '')).toHaveLength(3);
  });

  it('refuses an update when nothing was ever published to that space', async () => {
    await expect(
      publishSpec(
        run({
          mode: 'update',
          target: {
            baseUrl: mock.url,
            space: 'SPEC',
            email: 'dev@example.com',
            apiToken: 'token-value',
          },
        }),
        { records: new MemoryRecords() },
      ),
    ).rejects.toBeInstanceOf(PublishError);
    expect(mock.pageCreates).toBe(0);
  });

  it('creates a second page only when the user explicitly asks for a new one', async () => {
    const records = new MemoryRecords();
    const base = run({
      target: {
        baseUrl: mock.url,
        space: 'SPEC',
        email: 'dev@example.com',
        apiToken: 'token-value',
      },
    });
    await publishSpec(base, { records });
    const forced = await publishSpec({ ...base, mode: 'create' }, { records });

    expect(forced.status).toBe('created');
    expect(mock.pageCreates).toBe(2);
  });

  it('records a failure without a page when Confluence refuses', async () => {
    const records = new MemoryRecords();
    const failing = { ...mock, url: 'http://127.0.0.1:1' };
    await expect(
      publishSpec(
        run({
          target: {
            baseUrl: failing.url,
            space: 'SPEC',
            email: 'dev@example.com',
            apiToken: 'token-value',
          },
        }),
        { records },
      ),
    ).rejects.toThrow(/연결하지 못했습니다/);
    expect([...records.rows.values()][0]?.status).toBe('failed');
  });
});

describe('preview', () => {
  it('reports the plan before anything is sent', async () => {
    const records = new MemoryRecords();
    const base = run({
      target: {
        baseUrl: mock.url,
        space: 'SPEC',
        email: 'dev@example.com',
        apiToken: 'token-value',
      },
    });
    const first = await previewPublish(
      {
        projectId: base.projectId,
        projectName: base.projectName,
        screen: base.screen,
        pins: base.pins,
        pinSeq: base.pinSeq,
        figmaUrl: base.figmaUrl,
        generatedAt: base.generatedAt,
        mode: 'auto',
        target: { space: 'SPEC' },
      },
      { records },
    );
    expect(first.plan).toBe('create');
    expect(first.attachments).toHaveLength(3);

    await publishSpec(base, { records });

    const same = await previewPublish(
      {
        projectId: base.projectId,
        projectName: base.projectName,
        screen: base.screen,
        pins: base.pins,
        pinSeq: base.pinSeq,
        figmaUrl: base.figmaUrl,
        generatedAt: base.generatedAt,
        mode: 'auto',
        target: { space: 'SPEC' },
      },
      { records },
    );
    expect(same.plan).toBe('skip');
    expect(mock.pageCreates).toBe(1);
  });
});
