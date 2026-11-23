import { describe, expect, it } from 'vitest';
import { createProject, DomainError, execute, type ExecuteContext } from '../src';

const AT = '2026-11-19T09:00:00.000Z';
const LATER = '2026-11-19T10:00:00.000Z';

const ctx: ExecuteContext = {
  at: LATER,
  nextId: () => {
    throw new Error('a rename allocates no ids');
  },
};

function project() {
  return createProject({ id: `PRJ_${'p'.repeat(12)}`, name: '새 화면', at: AT });
}

describe('project.rename', () => {
  it('trims the name, stamps updatedAt and emits project.renamed', () => {
    const before = project();
    const result = execute(before, { type: 'project.rename', name: '  주문 상세 기획  ' }, ctx);
    expect(result.project.name).toBe('주문 상세 기획');
    expect(result.project.updatedAt).toBe(LATER);
    expect(result.events).toEqual([
      { type: 'project.renamed', projectId: before.id, name: '주문 상세 기획' },
    ]);
    expect(before.name).toBe('새 화면');
  });

  it.each(['', '   ', '\t\n'])('rejects an empty name (%j) with invalid_input', (name) => {
    let caught: unknown;
    try {
      execute(project(), { type: 'project.rename', name }, ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('invalid_input');
  });
});
