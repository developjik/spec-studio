import type { Project } from '@spec-studio/protocol';
import type { DaemonProjectSummary } from './daemon';

export const DEFAULT_TITLE = 'spec-studio — 화면 한 장으로 시작하는 기획';

/** Most recently touched first — the order the connect-time auto-open picks from. */
export function projectsByRecent<T extends Pick<DaemonProjectSummary, 'updatedAt'>>(
  projects: readonly T[],
): T[] {
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The window title names the project, so two projects whose screens share a
 * title stay apart in the tab strip and the OS window list.
 */
export function windowTitle(project: Pick<Project, 'name' | 'screen'> | null): string {
  if (project === null || project.screen === null) return DEFAULT_TITLE;
  const name = project.name.trim();
  const screen = project.screen.title.trim();
  const parts = [name, screen].filter((part, index, all) => part !== '' && all.indexOf(part) === index);
  return parts.length === 0 ? DEFAULT_TITLE : `${parts.join(' · ')} · spec-studio`;
}

/** One option row in the switcher: the name, plus the screen when it says more. */
export function switcherLabel(summary: Pick<DaemonProjectSummary, 'name' | 'screenTitle'>): string {
  const name = summary.name.trim() === '' ? '이름 없는 프로젝트' : summary.name.trim();
  const screen = summary.screenTitle?.trim() ?? '';
  return screen === '' || screen === name ? name : `${name} — ${screen}`;
}
