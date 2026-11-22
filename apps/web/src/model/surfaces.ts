import type { UiMode } from './settings';

/**
 * F1's easy/pro gate reads this declarative map. Each decomposed surface
 * declares its exposure tier here; the component stamps the same pair onto
 * its root element as `data-surface`/`data-exposure` via `surfaceProps`, so
 * the DOM and this registry can never drift.
 *
 * Final grades (E4 §3 F1): easy = 캔버스 + 문서 + AI 제안 카드 + 출력 3종 and
 * the shell around them. The pro set — 그래프·RTM(graphView), 인박스
 * (ideaInbox), 근거 패널(evidencePanel), 에이전트 런(runPanel), 발행
 * (publishModal) — is hidden only, never deleted (DG-3). `aiSettings` stays
 * easy because it is the door to LLM 제안 추출, and `figmaBar` stays pro as
 * an advanced attach path. Backup and the publish button are gated inside
 * TopBar, the same way the maturity badge is pro-only (DG-1).
 */
export type SurfaceExposure = 'easy' | 'pro';

export const SURFACE_EXPOSURE = {
  topBar: 'easy',
  bootScreen: 'easy',
  entryGate: 'easy',
  canvas: 'easy',
  figmaBar: 'pro',
  pinPanel: 'easy',
  docPanel: 'easy',
  evidencePanel: 'pro',
  ideaInbox: 'pro',
  graphView: 'pro',
  runPanel: 'pro',
  aiSettings: 'easy',
  outputModal: 'easy',
  publishModal: 'pro',
  notice: 'easy',
  dropVeil: 'easy',
} as const satisfies Record<string, SurfaceExposure>;

export type SurfaceId = keyof typeof SURFACE_EXPOSURE;

/** The whole map in pro; only the easy tier in easy (DG-3: hidden ≠ deleted). */
export function surfaceVisible(id: SurfaceId, mode: UiMode): boolean {
  return mode === 'pro' || SURFACE_EXPOSURE[id] === 'easy';
}

/** Stamp a surface's declarative exposure onto its root DOM element. */
export function surfaceProps(id: SurfaceId): {
  'data-surface': SurfaceId;
  'data-exposure': SurfaceExposure;
} {
  return { 'data-surface': id, 'data-exposure': SURFACE_EXPOSURE[id] };
}
