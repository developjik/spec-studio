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
families the v1.1 roadmap asks for. A case is data:

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

## What mock mode measures

Mock mode is the rule extractor that ships as the fallback: a policy pin becomes a policy, a data
pin becomes a contract, an exception pin becomes a requirement plus a QA case. It is a baseline,
not a model, and the three deliberately hard cases (POL-07, TAB-06, EXC-09 — a policy, a table and
an exception each written inside a `function` pin) score 0% on types and links. That is the number
`--live` is meant to move.
