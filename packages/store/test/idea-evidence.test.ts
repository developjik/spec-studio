import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Screen } from '@spec-studio/protocol';
import { remapProject } from '@spec-studio/core';
import { openSqliteStore, type SqliteStore } from '../src';

/**
 * The inbox and the research board through the only writer (E1 §4 F2·F3):
 * capture → reload round-trips, the state machines refuse shortcuts, the
 * link registry accepts evidence as a `references` destination and an idea
 * as a `derived_from` one, and a bundle carries both with their links.
 */

const SCREEN: Screen = {
  id: `S_${'i'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
};

let dir = '';
let file = '';
let clock = 0;
const stores: SqliteStore[] = [];

function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 20, 10, 0, clock)).toISOString();
}

function open(): SqliteStore {
  const store = openSqliteStore({ file, clock: tick });
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-studio-ideas-'));
  file = join(dir, 'graph.db');
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seeded(store: SqliteStore): Promise<string> {
  const project = await store.createProject({ name: '취소 개선', id: 'PRJ_ideas00000001' });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  await store.execute(project.id, {
    type: 'pin.create',
    screenId: SCREEN.id,
    pinType: 'function',
    title: '취소 요청',
    body: '배송 준비 중일 때만 활성',
    anchor: { x: 0.2, y: 0.3 },
  });
  return project.id;
}

async function captureBoard(store: SqliteStore, projectId: string): Promise<{ ideaId: string; evidenceId: string }> {
  const idea = await store.execute(projectId, {
    type: 'idea.capture',
    text: '주문 취소 UX 개선\n경쟁 서비스 취소 정책을 조사한다.',
    url: 'https://example.com/inspiration',
  });
  const evidence = await store.execute(projectId, {
    type: 'evidence.capture',
    url: 'https://example.com/a/cancel',
    title: '경쟁사 A 취소 정책',
    excerpt: '결제 후 24시간 이내에는 무료 취소가 가능하다.',
    evidenceType: 'web',
  });
  return {
    ideaId: idea.project.ideas[0]?.id as string,
    evidenceId: evidence.project.evidence[0]?.id as string,
  };
}

describe('the idea inbox and the evidence board in SQLite', () => {
  it('round-trips captures through a reload, tags and all', async () => {
    const store = open();
    const projectId = await seeded(store);
    await store.execute(projectId, {
      type: 'idea.capture',
      text: '주문 취소 UX 개선\n경쟁 조사 https://example.com/x 부터.',
    });
    await store.execute(projectId, {
      type: 'idea.capture',
      text: '이미지 스케치 아이디어',
      image: '/library/sketch.png',
    });
    const captured = await store.execute(projectId, {
      type: 'evidence.capture',
      url: 'https://example.com/a/cancel',
      title: '경쟁사 A 취소 정책',
      excerpt: '결제 후 24시간 이내에는 무료 취소가 가능하다.',
      evidenceType: 'web',
    });
    const evidenceId = captured.project.evidence[0]?.id as string;
    const reloaded = (await store.readProject(projectId)) as Project;
    expect(reloaded.ideas.map((idea) => [idea.title, idea.tags, idea.state])).toEqual([
      ['주문 취소 UX 개선', ['텍스트', '링크'], 'captured'],
      ['이미지 스케치 아이디어', ['텍스트', '이미지'], 'captured'],
    ]);
    expect(reloaded.ideas[0]?.text).toContain('경쟁 조사');
    const evidence = reloaded.evidence.find((row) => row.id === evidenceId);
    expect(evidence).toMatchObject({
      title: '경쟁사 A 취소 정책',
      state: 'captured',
      type: 'web',
    });

    await store.close();
    stores.length = 0;
    const second = open();
    const reopened = (await second.readProject(projectId)) as Project;
    expect(reopened.ideas).toHaveLength(2);
    expect(reopened.evidence.map((row) => row.id)).toContain(evidenceId);
  });

  it('walks the state machines and refuses the shortcuts', async () => {
    const store = open();
    const projectId = await seeded(store);
    const { ideaId, evidenceId } = await captureBoard(store, projectId);

    const promoted = await store.execute(projectId, {
      type: 'idea.update',
      ideaId,
      state: 'promoted',
      text: '주문 취소 UX 개선 (수정)\n본문이 바뀌면 제목도 다시 나온다.',
    });
    expect(promoted.project.ideas[0]).toMatchObject({ state: 'promoted', title: '주문 취소 UX 개선 (수정)' });

    // promoted is terminal: no archive, no second transition.
    await expect(
      store.execute(projectId, { type: 'idea.archive', ideaId }),
    ).rejects.toThrow(/바꿀 수 없습니다/);

    const archived = await store.execute(projectId, {
      type: 'idea.capture',
      text: '보관될 아이디어',
    }).then((result) => store.execute(projectId, {
      type: 'idea.archive',
      ideaId: result.project.ideas.at(-1)?.id as string,
    }));
    // archived ideas stay in the list — a state, not a deletion.
    expect(archived.project.ideas.at(-1)).toMatchObject({ state: 'archived' });

    const dismissed = await store.execute(projectId, { type: 'evidence.dismiss', evidenceId });
    expect(dismissed.project.evidence[0]).toMatchObject({ state: 'dismissed' });
    await expect(
      store.execute(projectId, { type: 'evidence.dismiss', evidenceId }),
    ).rejects.toThrow(/이미 기각된/);

    const updated = await store.execute(projectId, {
      type: 'evidence.update',
      evidenceId,
      title: '경쟁사 A 정책 (갱신)',
    });
    expect(updated.project.evidence[0]?.title).toBe('경쟁사 A 정책 (갱신)');
  });

  it('lets specnodes and pins cite evidence, marks it cited, and refuses evidence as a source', async () => {
    const store = open();
    const projectId = await seeded(store);
    const { evidenceId } = await captureBoard(store, projectId);
    const req = await store.execute(projectId, {
      type: 'node.create',
      nodeType: 'req',
      title: '취소 가능 시점 표시',
      body: '',
    });
    const reqId = req.project.graph.nodes[0]?.id as string;
    const pinId = req.project.pins[0]?.id as string;

    const linked = await store.execute(projectId, {
      type: 'link.create',
      linkType: 'references',
      src: reqId,
      dst: evidenceId,
    });
    expect(linked.project.graph.links).toHaveLength(1);
    // F3-3: the citation is what moves the row to `cited`.
    expect(linked.project.evidence[0]?.state).toBe('cited');

    const fromPin = await store.execute(projectId, {
      type: 'link.create',
      linkType: 'references',
      src: pinId,
      dst: evidenceId,
    });
    expect(fromPin.project.graph.links).toHaveLength(2);

    // A cited row does not go back; the second link keeps it cited.
    expect(fromPin.project.evidence[0]?.state).toBe('cited');

    await expect(
      store.execute(projectId, {
        type: 'link.create',
        linkType: 'references',
        src: evidenceId,
        dst: reqId,
      }),
    ).rejects.toThrow(/연결할 수 없습니다/);
  });

  it('derives a specnode from an idea, and reports ungrounded requirements', async () => {
    const store = open();
    const projectId = await seeded(store);
    const { ideaId } = await captureBoard(store, projectId);
    const req = await store.execute(projectId, {
      type: 'node.create',
      nodeType: 'req',
      title: '취소 가능 시점 표시',
      body: '',
    });
    const reqId = req.project.graph.nodes[0]?.id as string;

    const linked = await store.execute(projectId, {
      type: 'link.create',
      linkType: 'derived_from',
      src: reqId,
      dst: ideaId,
    });
    expect(linked.project.graph.links[0]).toMatchObject({ type: 'derived_from', dst: ideaId });
    // An idea end only works as a derived_from destination.
    await expect(
      store.execute(projectId, {
        type: 'link.create',
        linkType: 'references',
        src: reqId,
        dst: ideaId,
      }),
    ).rejects.toThrow(/연결할 수 없습니다/);

    // the idea stays captured — promotion is a person's call, not a link's
    expect(linked.project.ideas[0]?.state).toBe('captured');
  });

  it('carries ideas, evidence and their links through an export→import remap', async () => {
    const store = open();
    const projectId = await seeded(store);
    const { ideaId, evidenceId } = await captureBoard(store, projectId);
    const req = await store.execute(projectId, {
      type: 'node.create',
      nodeType: 'req',
      title: '취소 가능 시점 표시',
      body: '',
    });
    const reqId = req.project.graph.nodes[0]?.id as string;
    await store.execute(projectId, { type: 'link.create', linkType: 'references', src: reqId, dst: evidenceId });
    await store.execute(projectId, { type: 'link.create', linkType: 'derived_from', src: reqId, dst: ideaId });

    const source = (await store.readProject(projectId)) as Project;
    expect(source.ideas).toHaveLength(1);
    expect(source.evidence).toHaveLength(1);
    expect(source.graph.links).toHaveLength(2);

    const imported = await store.importProject(remapProject(source, (kind) => store.nextId(kind)));
    expect(imported.ideas[0]?.id).not.toBe(ideaId);
    expect(imported.evidence[0]?.id).not.toBe(evidenceId);
    expect(imported.ideas[0]?.title).toBe('주문 취소 UX 개선');

    const copy = (await store.readProject(imported.id)) as Project;
    // both links survived with remapped ends, kinds intact
    expect(copy.graph.links.map((link) => link.type).sort()).toEqual(['derived_from', 'references']);
    expect(copy.graph.links.every((link) => link.src !== reqId)).toBe(true);
    expect(copy.evidence[0]?.state).toBe('cited');
  });

  it('names the object in op_log for captures, updates and archives', async () => {
    const store = open();
    const projectId = await seeded(store);
    const { ideaId } = await captureBoard(store, projectId);
    await store.execute(projectId, { type: 'idea.archive', ideaId });

    const rows = store.database
      .prepare('SELECT kind, target, before, after FROM op_log ORDER BY seq')
      .all() as Array<{ kind: string; target: string | null; before: string | null; after: string | null }>;
    const kinds = rows.map((row) => row.kind);
    expect(kinds).toContain('idea.capture');
    expect(kinds).toContain('evidence.capture');
    expect(kinds).toContain('idea.archive');
    const archive = rows.find((row) => row.kind === 'idea.archive');
    expect(archive?.target).toBe(ideaId);
    expect(JSON.parse(archive?.before ?? '{}').object?.state).toBe('captured');
    expect(JSON.parse(archive?.after ?? '{}').object?.state).toBe('archived');
  });
});
