import { describe, expect, it } from 'vitest';
import type { AiBriefDraft } from '@spec-studio/protocol';
import { washBriefDraft } from '../src/grounding';

/** AC-3 (E3 F2): web citations are grounded or gone — the wash is the machine
 * half of 환각 출처 0, and it is pure so the eval scores the same function
 * the daemon runs before the card. */

function draft(claims: Array<{ sourceUrls?: string[]; evidenceRefs?: string[]; ungrounded?: boolean }>): AiBriefDraft {
  return {
    title: '경쟁 브리프',
    summary: '요약',
    claims: claims.map((claim) => ({
      text: '주장',
      evidenceRefs: claim.evidenceRefs ?? [],
      sourceUrls: claim.sourceUrls ?? [],
      ungrounded: claim.ungrounded ?? false,
    })),
  };
}

describe('washBriefDraft — AC-3', () => {
  const reported = new Set(['https://good.example/a', 'https://good.example/b']);

  it('keeps citations the tool actually reported', () => {
    const { draft: washed, removedUrls } = washBriefDraft(draft([{ sourceUrls: ['https://good.example/a'] }]), reported);
    expect(washed.claims[0]!.sourceUrls).toEqual(['https://good.example/a']);
    expect(removedUrls).toEqual([]);
  });

  it('removes an invented url and marks the claim ungrounded', () => {
    const { draft: washed, removedUrls } = washBriefDraft(
      draft([{ sourceUrls: ['https://made-up.example/x'] }]),
      reported,
    );
    expect(washed.claims[0]!.sourceUrls).toEqual([]);
    expect(washed.claims[0]!.ungrounded).toBe(true);
    expect(removedUrls).toEqual(['https://made-up.example/x']);
  });

  it('a claim keeping one real url out of a mixed pair stays grounded', () => {
    const { draft: washed, removedUrls } = washBriefDraft(
      draft([{ sourceUrls: ['https://good.example/a', 'https://fake.example/z'] }]),
      reported,
    );
    expect(washed.claims[0]!.sourceUrls).toEqual(['https://good.example/a']);
    expect(washed.claims[0]!.ungrounded).toBe(false);
    expect(removedUrls).toEqual(['https://fake.example/z']);
  });

  it('evidence ids pass through untouched — the card gate owns them (E1)', () => {
    const { draft: washed, removedUrls } = washBriefDraft(
      draft([{ evidenceRefs: ['E_abcdefgh1234'] }]),
      reported,
    );
    expect(washed.claims[0]!.evidenceRefs).toEqual(['E_abcdefgh1234']);
    expect(removedUrls).toEqual([]);
  });

  it('an already-honest ungrounded claim stays honest', () => {
    const { draft: washed } = washBriefDraft(draft([{ ungrounded: true }]), reported);
    expect(washed.claims[0]!.ungrounded).toBe(true);
  });
});
