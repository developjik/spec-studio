/**
 * E4 F1 — UI mode is a *local setting*, not project state (§4.3-A2). It lives
 * under its own localStorage key, outside the DB and the export bundle, so a
 * mode flip writes no command (DG-2) and the bundle hash stays put (AC-4).
 *
 * New-user detection (U-3 + A2): with no saved choice, "기존 로컬 데이터
 * 부재" — the caller's `loadProject() === null` answer — means easy; a stored
 * project means an existing user → pro. The resolved default is persisted on
 * the spot: a person who never touches the switch must not find the mode
 * flipped on the next boot just because their first project now exists.
 */
import { loadProject } from './storage';

export const SETTINGS_KEY = 'spec-studio.settings.v1';

export type UiMode = 'easy' | 'pro';

export interface LocalSettings {
  mode?: UiMode;
  /** F4's onboarding/tour progress lands here later — same local home. */
  [key: string]: unknown;
}

export function loadLocalSettings(): LocalSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as LocalSettings;
  } catch {
    return {};
  }
}

/** The saved choice, or null when the user has never been assigned a mode. */
export function loadUiMode(): UiMode | null {
  const mode = loadLocalSettings().mode;
  return mode === 'easy' || mode === 'pro' ? mode : null;
}

/** Merge-write: a mode save must not clobber sibling settings (온보딩 진행 등). */
export function saveUiMode(mode: UiMode): void {
  try {
    const next = { ...loadLocalSettings(), mode };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Quota or privacy mode: the in-memory mode still works for the session.
  }
}

/**
 * The boot decision. `hasStoredProject` is the A2 detector — callers pass
 * `loadProject() !== null`. A saved choice always wins; otherwise the answer
 * is resolved and remembered so it is stable for the life of the install.
 */
export function resolveUiMode(hasStoredProject: boolean): UiMode {
  const saved = loadUiMode();
  if (saved !== null) return saved;
  const mode: UiMode = hasStoredProject ? 'pro' : 'easy';
  saveUiMode(mode);
  return mode;
}

/**
 * DEV-100 — cross-tab sync. A mode flip in another tab only reaches this tab
 * through the `storage` event (fired for other documents, never the writer),
 * so subscribe to it; `key === null` is a `localStorage.clear()` elsewhere.
 * Window `focus` re-reads too, for shells that do not deliver `storage`
 * across windows. A missing/invalid saved mode is ignored: the tab keeps its
 * current mode rather than re-detecting mid-session.
 */
export function subscribeUiMode(
  onChange: (mode: UiMode) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const reread = () => {
    const mode = loadUiMode();
    if (mode !== null) onChange(mode);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY || event.key === null) reread();
  };
  target.addEventListener('storage', onStorage);
  target.addEventListener('focus', reread);
  return () => {
    target.removeEventListener('storage', onStorage);
    target.removeEventListener('focus', reread);
  };
}

/** Convenience for the hook: detect + resolve in one call. */
export function bootUiMode(): UiMode {
  return resolveUiMode(loadProject() !== null);
}
