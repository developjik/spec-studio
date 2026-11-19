import { normalizeProject } from '@spec-studio/core';
import { ProjectSchema, type Project } from '@spec-studio/protocol';

const STORAGE_KEY = 'spec-studio.project.v1';

export type SaveOutcome = { ok: true } | { ok: false; reason: string };

export function loadProject(): Project | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = ProjectSchema.safeParse(JSON.parse(raw));
    return parsed.success ? normalizeProject(parsed.data) : null;
  } catch {
    return null;
  }
}

/**
 * The prototype keeps state in localStorage. A large pasted image can exceed
 * the quota, so this reports the failure instead of losing the pins silently.
 */
export function saveProject(project: Project): SaveOutcome {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: '브라우저 저장 공간이 부족해 자동 저장하지 못했습니다. JSON으로 내보내 주세요.',
    };
  }
}

export function clearStoredProject(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function parseProjectFile(text: string): Project {
  const parsed = ProjectSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error('spec-studio 프로젝트 JSON이 아닙니다.');
  }
  return normalizeProject(parsed.data);
}

export function downloadProject(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const code = project.screen?.code ?? 'project';
  anchor.href = url;
  anchor.download = `spec-studio-${code.toLowerCase()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
