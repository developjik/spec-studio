import type { UiMode } from './settings';

/**
 * F1's easy/pro gate reads this declarative map. Each decomposed surface
 * declares its exposure tier here; the component stamps the same pair onto
 * its root element as `data-surface`/`data-exposure` via `surfaceProps`, so
 * the DOM and this registry can never drift.
 *
 * Final grades (E4 §3 F1 + F2): easy = 캔버스 + 문서 + AI 제안 카드 + 출력
 * 3종 + the F2 input layer, and the shell around them. The pro set —
 * 그래프·RTM(graphView), 인박스(ideaInbox), 근거 패널(evidencePanel), 발행
 * (publishModal) — is hidden only, never deleted (DG-3). `aiSettings` stays
 * easy because it is the door to LLM 제안 추출, and `figmaBar` stays pro as
 * an advanced attach path. Backup and the publish button are gated inside
 * TopBar, the same way the maturity badge is pro-only (DG-1).
 *
 * F2 (E4 §3 F2 · U-2 점진 재배치): easy's first screen fronts the input
 * layer — `chatDock` carries "올리고, 대화로 시작" above the unchanged
 * workshop, and `runPanel` is regraded easy because the needs_input answer
 * UI *is* the chat skeleton the dock starts (A-F2-2). It still renders only
 * while runs exist, and pro keeps it in the side rail — the workshop is
 * rearranged, never replaced (a안).
 *
 * Tiers: `easy` surfaces show in both modes (pro is the superset), `pro`
 * hides in easy, and `easyOnly` hides in pro — the dock is the first
 * easy-only surface: pro keeps its own run rail, so a second input layer
 * would only double the panel (A-F2-1: pro's workshop stays as-was).
 */
export type SurfaceExposure = 'easy' | 'pro' | 'easyOnly';

export const SURFACE_EXPOSURE = {
  topBar: 'easy',
  bootScreen: 'easy',
  entryGate: 'easy',
  chatDock: 'easyOnly',
  canvas: 'easy',
  figmaBar: 'pro',
  pinPanel: 'easy',
  docPanel: 'easy',
  evidencePanel: 'pro',
  ideaInbox: 'pro',
  graphView: 'pro',
  runPanel: 'easy',
  aiSettings: 'easy',
  outputModal: 'easy',
  publishModal: 'pro',
  notice: 'easy',
  dropVeil: 'easy',
} as const satisfies Record<string, SurfaceExposure>;

export type SurfaceId = keyof typeof SURFACE_EXPOSURE;

/**
 * Pro sees every tier except `easyOnly`; easy sees every tier except `pro`
 * (DG-3: hidden ≠ deleted — the element leaves the DOM, the feature does
 * not).
 */
export function surfaceVisible(id: SurfaceId, mode: UiMode): boolean {
  return mode === 'pro'
    ? SURFACE_EXPOSURE[id] !== 'easyOnly'
    : SURFACE_EXPOSURE[id] !== 'pro';
}

/** Stamp a surface's declarative exposure onto its root DOM element. */
export function surfaceProps(id: SurfaceId): {
  'data-surface': SurfaceId;
  'data-exposure': SurfaceExposure;
} {
  return { 'data-surface': id, 'data-exposure': SURFACE_EXPOSURE[id] };
}
