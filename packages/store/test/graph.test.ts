import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { openSqliteStore, type SqliteStore } from '@spec-studio/store';

/**
 * The graph is only real if it survives the file. These cases drive the same
 * store the daemon owns: four node kinds and seven links written to `obj` and
 * `link`, read back in one call, one decision card adopted, one undo, and a
 * backup a second SQLite connection can open.
 */

const AT = '2026-11-19T11:00:00.000Z';

const SCREEN: Screen = {
  id: `S_${'s'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

let dir = '';
let file = '';
let store: SqliteStore;

function open(): SqliteStore {
  return openSqliteStore({ file, clock: () => AT });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-graph-'));
  file = join(dir, 'graph.db');
  store = open();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seeded(): Promise<{ projectId: string; screenId: string; pinIds: string[] }> {
  const project = await store.createProject({ name: '주문 상세', at: AT });
  await store.execute(project.id, { type: 'screen.attach', screen: SCREEN });
  const pinIds: string[] = [];
  for (const [index, pinType] of (['function', 'policy', 'exception'] as const).entries()) {
    const outcome = await store.execute(project.id, {
      type: 'pin.create',
      screenId: SCREEN.id,
      pinType,
      title: ['취소 요청', '배송 시작 후 취소 불가', '재고 없음 안내'][index]!,
      body: ['배송 준비 중일 때만 활성', '사전조건: 배송 시작', '재고 0이면 버튼 비활성'][index]!,
      anchor: { x: 0.2 + index * 0.2, y: 0.3 },
    });
    pinIds.push(outcome.project.pins.at(-1)!.id);
  }
  return { projectId: project.id, screenId: SCREEN.id, pinIds };
}

describe('the graph in SQLite', () => {
  it('writes the four node kinds into obj and reads all six back', async () => {
    const { projectId, pinIds } = await seeded();
    const req = await store.execute(projectId, { type: 'node.create', nodeType: 'req', title: '취소 요청', body: '설명' });
    const reqId = req.project.graph.nodes.at(-1)!.id;
    const policy = await store.execute(projectId, { type: 'node.create', nodeType: 'policy', title: '배송 전 취소', body: '' });
    const policyId = policy.project.graph.nodes.at(-1)!.id;
    const contract = await store.execute(projectId, { type: 'node.create', nodeType: 'contract', title: '취소 API', body: '' });
    const contractId = contract.project.graph.nodes.at(-1)!.id;
    const qa = await store.execute(projectId, { type: 'node.create', nodeType: 'qa', title: 'QA 확인', body: '' });
    const qaId = qa.project.graph.nodes.at(-1)!.id;

    expect([reqId.startsWith('N_'), contractId.startsWith('C_'), qaId.startsWith('V_')]).toEqual([true, true, true]);

    await store.execute(projectId, { type: 'link.create', linkType: 'implements', src: pinIds[0]!, dst: reqId });
    await store.execute(projectId, { type: 'link.create', linkType: 'governs', src: policyId, dst: pinIds[1]! });
    await store.execute(projectId, { type: 'link.create', linkType: 'verifies', src: qaId, dst: pinIds[0]! });
    await store.execute(projectId, { type: 'link.create', linkType: 'derived_from', src: contractId, dst: pinIds[2]! });

    await store.close();
    store = open();
    const read = await store.readProject(projectId);
    expect(read?.graph.nodes.map((node) => node.type).sort()).toEqual(['contract', 'policy', 'qa', 'req']);
    expect(read?.graph.links.map((link) => link.type).sort()).toEqual([
      'derived_from',
      'governs',
      'implements',
      'verifies',
    ]);

    const rows = store.database
      .prepare("SELECT kind, subtype FROM obj WHERE id IN (?, ?, ?, ?)")
      .all(reqId, policyId, contractId, qaId) as Array<{ kind: string; subtype: string | null }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'specnode', subtype: 'requirement' },
        { kind: 'specnode', subtype: 'policy' },
        { kind: 'contract', subtype: 'api' },
        { kind: 'verification', subtype: null },
      ]),
    );
  });

  it('persists the pin-derived decision card, adopts it in one write, and reverts it', async () => {
    const { projectId } = await seeded();
    const proposed = await store.execute(projectId, { type: 'graph.proposal.create' });
    const card = proposed.project.graphProposal;
    expect(card).not.toBeNull();
    expect(card!.nodes.length).toBeGreaterThan(2);

    const adopted = await store.execute(projectId, { type: 'graph.proposal.adopt', proposalId: card!.id });
    expect(adopted.project.graph.nodes.length).toBe(card!.nodes.length);
    expect(adopted.project.graph.links.length).toBe(card!.links.length);

    const revertable = store.lastRevertable(projectId);
    expect(revertable?.kind).toBe('graph');
    expect(revertable?.nodes).toBe(card!.nodes.length);

    const reverted = await store.revert(projectId);
    expect(reverted.project.graph.nodes).toHaveLength(0);
    expect(reverted.project.graph.links).toHaveLength(0);
    expect(reverted.project.graphProposal?.state).toBe('reverted');

    const ledger = store.database
      .prepare("SELECT kind, before FROM op_log WHERE kind IN ('graph.proposal.adopt','graph.proposal.revert') ORDER BY seq")
      .all() as Array<{ kind: string; before: string }>;
    expect(ledger.map((row) => row.kind)).toEqual(['graph.proposal.adopt', 'graph.proposal.revert']);
    expect(JSON.parse(ledger[0]!.before)).toMatchObject({ nodes: expect.any(Array) });
    expect(store.lastRevertable(projectId)).toBeNull();
  });

  it('removes a deleted node from obj with a tombstone and drops its links', async () => {
    const { projectId, pinIds } = await seeded();
    const req = await store.execute(projectId, { type: 'node.create', nodeType: 'req', title: '취소 요청', body: '' });
    const reqId = req.project.graph.nodes[0]!.id;
    await store.execute(projectId, { type: 'link.create', linkType: 'implements', src: pinIds[0]!, dst: reqId });
    await store.execute(projectId, { type: 'node.delete', nodeId: reqId });

    const read = await store.readProject(projectId);
    expect(read?.graph.nodes).toHaveLength(0);
    expect(read?.graph.links).toHaveLength(0);
    const row = store.database
      .prepare('SELECT deleted_at FROM obj WHERE id = ?')
      .get(reqId) as { deleted_at: string | null };
    expect(row.deleted_at).toBe(AT);
  });

  it('backs the project up into a second SQLite file the daemon can be pointed at', async () => {
    const { projectId } = await seeded();
    const backup = store.backupTo(join(dir, 'backups'));
    expect(backup.bytes).toBeGreaterThan(0);

    const copy = new DatabaseSync(backup.path);
    const project = copy.prepare('SELECT id, name FROM project WHERE id = ?').get(projectId) as
      | { id: string; name: string }
      | undefined;
    const pins = copy.prepare("SELECT count(*) AS n FROM obj WHERE kind = 'pin'").get() as { n: number };
    copy.close();
    expect(project?.name).toBe('주문 상세');
    expect(pins.n).toBe(3);
  });
});
