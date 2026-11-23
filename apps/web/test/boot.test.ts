import { describe, expect, it } from 'vitest';
import type { Doc } from '@spec-studio/protocol';
import { activeDocOf, bootProjectOf } from '../src/model/boot';
import type { DaemonProjectSummary } from '../src/model/daemon';

/**
 * DEV-76: a `?doc=` deep link — or a back navigation onto a history entry
 * that carries one — must reopen the project that owns that doc, not the
 * most recently touched project.
 */

const summary = (
  id: string,
  updatedAt: string,
  docIds: string[],
): DaemonProjectSummary => ({
  id,
  name: id,
  updatedAt,
  screenTitle: null,
  screenCode: null,
  pins: 0,
  figmaUrl: null,
  docs: docIds.map((docId) => ({ id: docId, title: docId, kind: 'spec', blocks: 0 })),
  proposalState: null,
  graphNodes: 0,
  graphLinks: 0,
  graphProposalState: null,
});

const doc = (id: string, kind: Doc['kind']): Doc => ({
  id,
  title: id,
  rev: 0,
  blocks: [],
  kind,
  deletedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

// Older project B owns the deep-linked research doc; A is the latest.
const older = summary('prj_b', '2026-11-01T00:00:00.000Z', ['doc_b_spec', 'doc_b_research']);
const latest = summary('prj_a', '2026-11-20T00:00:00.000Z', ['doc_a_spec']);
const projects = [latest, older];

/** What a fresh load of `search` does: pick the project, then the doc on screen. */
function boot(search: string, docsOf: (projectId: string) => Doc[]) {
  const wanted = new URLSearchParams(search).get('doc');
  const project = bootProjectOf(projects, wanted);
  return {
    projectId: project?.id ?? null,
    docId: project === undefined ? null : (activeDocOf(docsOf(project.id), wanted)?.id ?? null),
  };
}

const docsOf = (projectId: string): Doc[] =>
  projectId === 'prj_b'
    ? [doc('doc_b_spec', 'spec'), doc('doc_b_research', 'research')]
    : [doc('doc_a_spec', 'spec')];

describe('bootProjectOf — the URL doc picks its owning project', () => {
  it('a deep link into a non-latest project opens that project, not the latest', () => {
    expect(bootProjectOf(projects, 'doc_b_research')?.id).toBe('prj_b');
    expect(bootProjectOf([older, latest], 'doc_b_spec')?.id).toBe('prj_b');
  });

  it('a deep link lands on the named doc itself, not the fallback spec', () => {
    expect(boot('?doc=doc_b_research', docsOf)).toEqual({
      projectId: 'prj_b',
      docId: 'doc_b_research',
    });
  });

  it('back navigation onto an entry of a non-latest project reopens that doc', () => {
    // The user read prj_b's research doc, then worked in prj_a (now latest),
    // then pressed back: the restored entry's URL boots the app again.
    const history = ['?doc=doc_b_research', '?doc=doc_a_spec'];
    expect(boot(history[1]!, docsOf)).toEqual({ projectId: 'prj_a', docId: 'doc_a_spec' });
    expect(boot(history[0]!, docsOf)).toEqual({
      projectId: 'prj_b',
      docId: 'doc_b_research',
    });
  });

  it('without a doc in the URL the most recently touched project reopens', () => {
    expect(bootProjectOf(projects, null)?.id).toBe('prj_a');
    expect(boot('', docsOf)).toEqual({ projectId: 'prj_a', docId: 'doc_a_spec' });
  });

  it('a dangling doc id falls back to the most recent project and its spec', () => {
    expect(bootProjectOf(projects, 'doc_gone')?.id).toBe('prj_a');
    expect(boot('?doc=doc_gone', docsOf)).toEqual({ projectId: 'prj_a', docId: 'doc_a_spec' });
  });

  it('an empty daemon has nothing to reopen', () => {
    expect(bootProjectOf([], 'doc_b_research')).toBeUndefined();
    expect(bootProjectOf([], null)).toBeUndefined();
  });

  it('does not reorder the caller’s list', () => {
    const list = [older, latest];
    bootProjectOf(list, null);
    expect(list.map((p) => p.id)).toEqual(['prj_b', 'prj_a']);
  });
});

describe('activeDocOf — the fallback rule', () => {
  const docs = [doc('doc_r', 'research'), doc('doc_s', 'spec')];

  it('the named doc wins while it exists', () => {
    expect(activeDocOf(docs, 'doc_r')?.id).toBe('doc_r');
  });

  it('a missing or absent pick falls to the first spec', () => {
    expect(activeDocOf(docs, 'doc_gone')?.id).toBe('doc_s');
    expect(activeDocOf(docs, null)?.id).toBe('doc_s');
  });

  it('with no spec the first doc is shown, and none means null', () => {
    expect(activeDocOf([doc('doc_r', 'research')], null)?.id).toBe('doc_r');
    expect(activeDocOf([], 'doc_r')).toBeNull();
  });
});
