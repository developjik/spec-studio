import { describe, expect, it } from 'vitest';
import {
  SURFACE_EXPOSURE,
  surfaceProps,
  surfaceVisible,
  type SurfaceId,
} from '../src/model/surfaces';

/**
 * E4 F1+F2 — the finalized exposure table (spec §3 F1 + §3 F2): easy =
 * canvas + docs + AI 제안 카드 + 출력 3종 and the shell around them, plus
 * the F2 input layer. The pro capabilities — 그래프·RTM(graphView),
 * 인박스(ideaInbox), 근거 패널(evidencePanel), 발행(publishModal), 백업 —
 * plus the Figma attach bar stay pro (DG-3: hidden, never deleted).
 * `aiSettings` is easy: it is the only door to LLM 제안 추출.
 *
 * F2: `runPanel` regrades to easy — the needs_input answer UI is the chat
 * skeleton the dock fronts (A-F2-2). `chatDock` is the first `easyOnly`
 * surface: easy gets the input layer above the workshop while pro keeps
 * its own rail — the same run surface, one placement each (a안).
 */

const EASY_SURFACES: readonly SurfaceId[] = [
  'topBar',
  'bootScreen',
  'entryGate',
  'canvas',
  'pinPanel',
  'docPanel',
  'runPanel',
  'aiSettings',
  'outputModal',
  'notice',
  'dropVeil',
];

const EASY_ONLY_SURFACES: readonly SurfaceId[] = ['chatDock'];

const PRO_ONLY_SURFACES: readonly SurfaceId[] = [
  'figmaBar',
  'evidencePanel',
  'ideaInbox',
  'graphView',
  'publishModal',
];

describe('SURFACE_EXPOSURE — F2 등급표', () => {
  it('17개 서피스 전부 등록되어 있다', () => {
    expect(Object.keys(SURFACE_EXPOSURE)).toHaveLength(17);
    expect(
      [...EASY_SURFACES, ...EASY_ONLY_SURFACES, ...PRO_ONLY_SURFACES].sort(),
    ).toEqual(Object.keys(SURFACE_EXPOSURE).sort());
  });

  it('간편 구성(캔버스·문서·AI 제안 카드·챗 뼈대·출력 3종 + 셸)은 easy', () => {
    for (const id of EASY_SURFACES) {
      expect(SURFACE_EXPOSURE[id], id).toBe('easy');
    }
  });

  it('챗 도크는 easyOnly — 전문 작업실은 현행 유지(A-F2-1)', () => {
    for (const id of EASY_ONLY_SURFACES) {
      expect(SURFACE_EXPOSURE[id], id).toBe('easyOnly');
    }
  });

  it('전문 기능(그래프·RTM·인박스·근거·발행·Figma바)은 pro', () => {
    for (const id of PRO_ONLY_SURFACES) {
      expect(SURFACE_EXPOSURE[id], id).toBe('pro');
    }
  });
});

describe('surfaceVisible — 모드 게이트', () => {
  it('전문 모드는 easyOnly만 숨긴다(무삭제 — DG-3)', () => {
    for (const id of Object.keys(SURFACE_EXPOSURE) as SurfaceId[]) {
      expect(surfaceVisible(id, 'pro'), id).toBe(
        SURFACE_EXPOSURE[id] !== 'easyOnly',
      );
    }
  });

  it('간편 모드는 easy + easyOnly만 노출, pro 서피스는 숨김', () => {
    for (const id of [...EASY_SURFACES, ...EASY_ONLY_SURFACES]) {
      expect(surfaceVisible(id, 'easy'), id).toBe(true);
    }
    for (const id of PRO_ONLY_SURFACES) {
      expect(surfaceVisible(id, 'easy'), id).toBe(false);
    }
  });
});

describe('surfaceProps — 스탬핑 정합', () => {
  it('DOM 스탬프가 레지스트리 등급과 항상 일치', () => {
    for (const id of Object.keys(SURFACE_EXPOSURE) as SurfaceId[]) {
      expect(surfaceProps(id)).toEqual({
        'data-surface': id,
        'data-exposure': SURFACE_EXPOSURE[id],
      });
    }
  });
});
