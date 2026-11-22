import type { AiBriefDraft } from '@spec-studio/protocol';

/**
 * AC-3's machine half (E3 F2): a brief's web citations are grounded or gone.
 * The runner collects every url the run's web_search tool actually returned;
 * this pure wash enforces it on the final draft before the card is written —
 * a claim citing a url the tool never reported loses the citation and says
 * `ungrounded` instead. The card never carries a hallucinated source (환각
 * 출처 0); the journal records each wash so the eval can count them.
 *
 * Evidence ids (`E_…`) are the project's own objects — they pass through
 * untouched here; the card gate at 채택 keeps rejecting ids the project does
 * not have (E1 계약 승계).
 */
export interface WashResult {
  draft: AiBriefDraft;
  /** Every removed citation, in order — journal food and eval food. */
  removedUrls: string[];
}

export function washBriefDraft(
  draft: AiBriefDraft,
  reportedUrls: ReadonlySet<string>,
): WashResult {
  const removedUrls: string[] = [];
  const claims = draft.claims.map((claim) => {
    const keptUrls = claim.sourceUrls.filter((url) => {
      const grounded = reportedUrls.has(url);
      if (!grounded) removedUrls.push(url);
      return grounded;
    });
    const lostAll = keptUrls.length === 0 && claim.evidenceRefs.length === 0;
    return {
      ...claim,
      sourceUrls: keptUrls,
      // A claim whose every citation washed out keeps the honest marker
      // instead of pretending — and one already honest stays honest.
      ungrounded: lostAll ? true : claim.ungrounded,
    };
  });
  return { draft: { ...draft, claims }, removedUrls };
}
