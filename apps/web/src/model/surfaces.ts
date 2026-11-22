/**
 * F1's easy/pro gate reads this declarative map (E4 §3 F0: 표기 구조만 —
 * 실제 게이팅 동작은 F1 범위다). Each decomposed surface declares its
 * exposure tier here; the component stamps the same pair onto its root
 * element as `data-surface`/`data-exposure` via `surfaceProps`, so the DOM
 * and this registry can never drift.
 *
 * The tiers below are F0's provisional defaults — F1 decides the real
 * split per surface when the mode switch ships.
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
  ideaInbox: 'easy',
  graphView: 'pro',
  runPanel: 'pro',
  aiSettings: 'pro',
  outputModal: 'pro',
  publishModal: 'pro',
  notice: 'easy',
  dropVeil: 'easy',
} as const satisfies Record<string, SurfaceExposure>;

export type SurfaceId = keyof typeof SURFACE_EXPOSURE;

/** Stamp a surface's declarative exposure onto its root DOM element. */
export function surfaceProps(id: SurfaceId): {
  'data-surface': SurfaceId;
  'data-exposure': SurfaceExposure;
} {
  return { 'data-surface': id, 'data-exposure': SURFACE_EXPOSURE[id] };
}
