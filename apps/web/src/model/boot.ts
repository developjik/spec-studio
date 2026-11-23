import type { Doc } from '@spec-studio/protocol';
import type { DaemonProjectSummary } from './daemon';

/**
 * Which daemon project a boot reopens. The URL's `?doc=` is the 정본 of what
 * the screen shows, so the project that owns that document wins — a deep
 * link or a back navigation must land where it points. Without a pick (or
 * with a dangling one) the most recently touched project is reopened.
 */
export function bootProjectOf(
  projects: readonly DaemonProjectSummary[],
  wantedDocId: string | null,
): DaemonProjectSummary | undefined {
  if (wantedDocId !== null) {
    const owner = projects.find((project) =>
      project.docs.some((doc) => doc.id === wantedDocId),
    );
    if (owner !== undefined) return owner;
  }
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

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
