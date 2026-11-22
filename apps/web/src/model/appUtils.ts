import type { ExecutionResult, Maturity } from '@spec-studio/core';
import type { Doc } from '@spec-studio/protocol';
import { nextEntityId } from './ids';

export type Notice = { tone: 'info' | 'error'; text: string };

export const nowIso = () => new Date().toISOString();

export const nextId = (
  kind:
    | 'project'
    | 'screen'
    | 'pin'
    | 'doc'
    | 'block'
    | 'proposal'
    | 'node'
    | 'link'
    | 'graphProposal'
    | 'idea'
    | 'evidence',
  nodeType?: 'req' | 'policy' | 'contract' | 'qa',
) => nextEntityId(kind, nodeType);

/** Before a project exists the header still needs a badge; L0 with no checks. */
export const EMPTY_MATURITY: Maturity = {
  level: 'L0',
  levels: [
    { level: 'L0', checks: [] },
    { level: 'L1', checks: [] },
    { level: 'L2', checks: [] },
  ],
  next: { level: 'L1', todo: [] },
  todo: [],
};
/** What a command application returns; `opSeq` is the store's undo handle. */
export type ApplyResult = ExecutionResult & { opSeq?: number };

/**
 * Which registry doc the panel shows: the URL's pick when it still exists,
 * else the first spec, else whatever exists. The URL is the 정본 of the choice,
 * so a dangling id simply falls through to the same rule a boot follows.
 */
export function activeDocOf(docs: readonly Doc[], wanted: string | null): Doc | null {
  if (wanted !== null) {
    const named = docs.find((doc) => doc.id === wanted);
    if (named !== undefined) return named;
  }
  return docs.find((doc) => doc.kind === 'spec') ?? docs[0] ?? null;
}
