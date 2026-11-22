import { describe, expect, it } from 'vitest';
import {
  SURFACE_EXPOSURE,
  surfaceProps,
  surfaceVisible,
  type SurfaceId,
} from '../src/model/surfaces';

/**
 * E4 F1 — the finalized exposure table (F0's provisional grades, now decided
 * against spec §3 F1): easy = canvas + docs + AI 제안 카드 + 출력 3종 and the
 * shell around them; the seven pro capabilities — 그래프·RTM(graphView),
 * 인박스(ideaInbox), 근거 패널(evidencePanel), 에이전트 런(runPanel),
 * 발행(publishModal), 백업 — plus the Figma attach bar stay pro (DG-3: hidden,
 * never deleted). `aiSettings` is easy: it is the only door to LLM 제안 추출,
 * and "AI 제안 카드" is a listed easy feature.
 */

const EASY_SURFACES: readonly SurfaceId[] = [
  'topBar',
  'bootScreen',
  'entryGate',
  'canvas',
  'pinPanel',
  'docPanel',
  'aiSettings',
  'outputModal',
  'notice',
  'dropVeil',
];

const PRO_ONLY_SURFACES: readonly SurfaceId[] = [
  'figmaBar',
  'evidencePanel',
  'ideaInbox',
  'graphView',
  'runPanel',
  'publishModal',
];

describe('SURFACE_EXPOSURE — F1 최종 등급표', () => {
  it('16개 서피스 전부 등록되어 있다', () => {
    expect(Object.keys(SURFACE_EXPOSURE)).toHaveLength(16);
    expect([...EASY_SURFACES, ...PRO_ONLY_SURFACES].sort()).toEqual(
      Object.keys(SURFACE_EXPOSURE).sort(),
    );
  });

  it('간편 구성(캔버스·문서·AI 제안 카드·출력 3종 + 셸)은 easy', () => {
    for (const id of EASY_SURFACES) {
      expect(SURFACE_EXPOSURE[id], id).toBe('easy');
    }
  });

  it('전문 기능(그래프·RTM·인박스·근거·에이전트 런·발행·Figma바)은 pro', () => {
    for (const id of PRO_ONLY_SURFACES) {
      expect(SURFACE_EXPOSURE[id], id).toBe('pro');
    }
  });
});

describe('surfaceVisible — 모드 게이트', () => {
  it('전문 모드는 16개 서피스 전부 노출(무삭제 — DG-3)', () => {
    for (const id of Object.keys(SURFACE_EXPOSURE) as SurfaceId[]) {
      expect(surfaceVisible(id, 'pro'), id).toBe(true);
    }
  });

  it('간편 모드는 easy만 노출, pro 서피스는 숨김', () => {
    for (const id of EASY_SURFACES) {
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
