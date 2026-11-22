# eval — AI 제안 품질

`pnpm eval` scores the proposal engines on the same thirty Korean screen-spec sentences. It is a
gate, not a demo: the totals are compared to fixed thresholds and the command exits non-zero when
they are missed.

```bash
pnpm eval                          # mock — the rule fallback, deterministic, no network (CI)
pnpm eval -- --mock                # the same, explicitly
ANTHROPIC_API_KEY=sk-… pnpm eval -- --live
pnpm eval -- --live --provider=openai --model=gpt-4o-mini --endpoint=http://127.0.0.1:11434/v1
```

Without `--mock`/`--live` the runner picks mock when no key is in the environment, so CI never
needs a secret and a developer who exported one gets the live measurement by default.

`pnpm test` runs the unit tests and then this gate, which is how CI runs it — the workflow file
only ever runs `pnpm test`. `pnpm test:unit` is the quick loop without the golden set.

## The set

`golden/policy.json`, `golden/table.json`, `golden/exception.json` — ten cases each, the three
families the v1.1 roadmap asks for: 정책 문장 (policy · governs), 표/계약 (contract · req,
derived_from · implements), 예외 (req · qa with handles_edge · verifies). A case is data:

```json
{
  "id": "POL-01",
  "note": "배송 단계에 걸린 취소 정책 한 문장",
  "screen": { "title": "주문 취소", "code": "SCR-210" },
  "pins": [{ "number": 1, "type": "policy", "title": "배송 시작 후 취소 불가", "body": "…" }],
  "expect": { "types": ["policy"], "links": ["governs"], "pins": [1] }
}
```

`types` and `links` are what a good card must contain; `pins` are the pin numbers the sentence
stands on and the drafts therefore have to cite. Changing what "good" means is editing JSON, not
code — and the same file grades the fallback and a model, so the comparison is honest.

## Scoring

| Column | Meaning | Threshold |
| --- | --- | --- |
| 스키마 | the proposal parses as a `GraphProposal` and has a node | 100% |
| 타입 | recall of the expected node types | ≥ 85% |
| 링크 | recall of the expected link types | ≥ 85% |
| 핀근거 | recall of the expected pin citations | ≥ 90% |
| 근거비율 | drafts citing an existing pin / all drafts | ≥ 90% |

Every case is built by the same commands the app sends (`screen.attach`, `pin.create`) and every
proposal goes through `execute(project, { type: 'graph.proposal.create', … })` — the daemon's own
path — so a draft that would be rejected in the app is rejected here too.

## The agent-research set (E3 F2 · AC-3)

`golden/agent-research.json` — ten cases running the run's own driver (`driveRun`) with a
scripted model and a scripted `web_search` tool. The gate is the wash law: a brief's web
citations are grounded or gone. Every kept `sourceUrls` entry must be a url the tool
reported, planted hallucinations must wash out to exactly the expected list, washed claims
keep the honest `ungrounded` marker, and question cases must route through `needs_input`
and finish. The wash the eval scores (`washBriefDraft`) is the same pure function the
daemon calls before the card — the gate and the product cannot drift apart. Threshold: 10/10.

## The brief set (E1 §7-B-3)

`golden/brief.json` — ten research-brief cases after the golden thirty: five where every evidence
claim is backed, three with no evidence at all, two mixed. A case seeds a real board through the
same commands the app sends (`idea.capture`, `evidence.capture` — fixture-set `E_…` ids included),
then grades the draft `buildFallbackBrief` (mock) or `requestBriefDraft` (live) produces:

| Metric | Meaning | Threshold |
| --- | --- | --- |
| 인용 정확성 | claims whose `evidenceRefs` are all provided ids — hallucinated citations are 0 | 100% |
| 마커 정확도 | cases where every claim is marked `ungrounded` exactly when it has no refs, and the grounded/ungrounded counts match `expect` | ≥ 90% |

The fallback is the same function the daemon's `mode: 'brief'` local plan uses, so the '로컬 규칙
폴백' badge and this gate defend one implementation. The two gates fold into the same PASS/FAIL
line; the golden-30 thresholds are untouched.

## What mock mode measures

Mock mode is the rule extractor that ships as the fallback: a policy pin becomes a policy, a data
pin becomes a contract, an exception pin becomes a requirement plus a QA case. It is a baseline,
not a model, and the three deliberately hard cases (POL-07, TAB-06, EXC-09 — a policy, a table and
an exception each written inside a `function` pin) score 0% on types and links. That is the number
`--live` is meant to move.
