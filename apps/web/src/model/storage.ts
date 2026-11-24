import { normalizeProject } from '@spec-studio/core';
import {
  normalizeLegacyProject,
  ProjectBundleSchema,
  ProjectSchema,
  type Project,
  type ProjectBundle,
} from '@spec-studio/protocol';

const STORAGE_KEY = 'spec-studio.project.v1';

export type SaveOutcome = { ok: true } | { ok: false; reason: string };

export function loadProject(): Project | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    // localStorage written before the registry carries one `doc`; reading it
    // is the same as a registry with that single document.
    const parsed = ProjectSchema.safeParse(normalizeLegacyProject(JSON.parse(raw)));
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
    window.localStorage.setItem(STORAGE_KEY, serializeProject(project));
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
  const parsed = ProjectSchema.safeParse(normalizeLegacyProject(JSON.parse(text)));
  if (!parsed.success) {
    throw new Error('spec-studio 프로젝트 JSON이 아닙니다.');
  }
  return normalizeProject(parsed.data);
}

export function downloadProject(project: Project): void {
  downloadBundle(bundleOf(project));
}

/** The file a person keeps: the project plus what it is and when it left. */
export function bundleOf(project: Project, at = new Date().toISOString()): ProjectBundle {
  return { format: 'spec-studio.bundle', version: 1, exportedAt: at, project };
}

export function downloadBundle(bundle: ProjectBundle): void {
  const blob = new Blob([JSON.stringify({...bundle,project:projectForStorage(bundle.project)}, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const code = bundle.project.screen?.code ?? 'project';
  anchor.href = url;
  anchor.download = `spec-studio-${code.toLowerCase()}-bundle.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * A bundle is the v1 format; a bare project file (the W1–W4 export) still
 * opens, because a file a person saved last month should not stop working.
 */
export function parseBundleFile(text: string): ProjectBundle {
  const raw = JSON.parse(text) as unknown;
  const asBundle = ProjectBundleSchema.safeParse(raw);
  if (asBundle.success) {
    return { ...asBundle.data, project: normalizeProject(asBundle.data.project) };
  }
  const asProject = ProjectSchema.safeParse(normalizeLegacyProject(raw));
  if (asProject.success) {
    return bundleOf(normalizeProject(asProject.data));
  }
  throw new Error('spec-studio 프로젝트 번들이 아닙니다.');
}

/** Persist the active image once; normalization reconstructs the screen alias. */
export function projectForStorage(project:Project):Project{
  return project.screens===undefined?project:{...project,screen:null};
}
export function serializeProject(project:Project):string{
  return JSON.stringify(projectForStorage(project));
}
