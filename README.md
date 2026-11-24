# spec-studio

**AI-native specification studio** — the project lives in a local SQLite file, screens carry
immutable numbered pins, and handoff documents are generated as static outputs. External tools
receive copies; they are never the source of truth.

[![CI](https://github.com/developjik/spec-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/spec-studio/actions/workflows/ci.yml)

**[라이브 데모 → https://developjik.github.io/spec-studio/](https://developjik.github.io/spec-studio/)**
— 설치도, 데몬도, 계정도 없이 브라우저에서 바로. 샘플 화면에 핀을 찍고, 문서 문단을 쓰고,
`그래프 · RTM`에서 추적 그래프를 보고, 출력 3종을 미리보기까지 해볼 수 있습니다. 정적
배포본이므로 프로젝트는 그 브라우저의 localStorage에만 남고, 제안은 로컬 규칙 폴백으로
동작합니다(LLM 제안·Confluence 발행·SQLite 저장은 데몬을 띄운 로컬 실행에서만).

> **Status: v1 phase 2.** A model can now propose, and the same decision card still decides.
> `AI 설정` puts a provider, a model and a key in the window — never in the database — and
> `제안 추출` files the answer as one card whose badge says **LLM 제안** (with provider and model)
> or **로컬 규칙 폴백**. Thirty Korean golden cases score both engines with `pnpm eval`.
>
> **v1 phase 1.** The project is now a graph as well as a screen. Six object types
> (화면 · 핀 · 요구사항 · 정책 · 계약 · QA) are joined by seven named links, the traceability view
> marks orphan pins and links that need a re-read, and the header walks **L0 → L1 → L2** as the
> spec becomes publish-ready. A pin-derived proposal drafts requirements, policies and QA cases
> as one decision card; adopting it creates them and their links in one write, and the same
> `op_log.before` undo reverses it. The whole project exports as one JSON bundle, imports as a new
> project with fresh ids, and the daemon snapshots the SQLite file on demand.

## Why

Korean screen specs already have a precise grammar: every element carries a number, the notes
cite that number, and states, permissions and exceptions hang off it. This project turns that
grammar into objects, so a reference like `SCR-110-3` keeps meaning the same thing after the
pin is edited, moved or deleted.

Three commitments follow from that:

1. **The number is immutable.** Deleting pin #3 leaves a gap; the next pin is #4, never #3.
2. **One local source of truth.** `graph.db` holds blocks, objects and events. Publish and
   capture paths write copies outward and record what they wrote.
3. **Start in three minutes.** No repository, dev server or seed data: paste a screenshot,
   click, and the first pin exists.

## What works today

- **Four ways in** — paste a screenshot (`Ctrl/Cmd+V`), drop or pick a file, load the sample
  screen, or register a Figma frame URL.
- **Numbered pins in three types** — 기능(function) · 정책(policy) · 예외(exception), each with a
  title and a description, placed at the exact point you clicked.
- **Edit in place, move by dragging** — the number stays through edits, drags and deletions;
  deleted numbers appear as **결번** and are never reused.
- **Three handoff outputs from one read of the pins** — overlay PNG, self-contained HTML, QA CSV
  with a BOM and the nine promised columns.
- **A Figma frame link per screen** — displayed in the app, clickable, and carried into the
  published body. It is reference data: nothing is fetched from Figma.
- **A local daemon** — `apps/daemon` binds `127.0.0.1`, serves the project API, and is the only
  writer of `graph.db`. The top bar says **SQLite 데몬 연결됨** when it is there and
  **브라우저 임시 모드** when it is not; without a daemon the app still runs on `localStorage`.
- **Confluence publishing** — REST v2 pages, v1 attachments, Storage-Format body with the screen
  summary, Figma link, the three tables, the gap notice and the attachment list. One page and
  three files per publish.
- **Idempotent by content** — the spec hash decides: same spec and space → nothing is sent;
  edited spec → the recorded page is updated; never published → one page is created.
- **Publish history in the app** — `publish_record` rows with time, result, space, page and hash.
- **A document next to the screen (W4)** — paragraph, heading, list and caption blocks with stable
  ids; add, edit, reorder and delete directly. Each block can carry pin chips (`#1`, `#2`).
  Pressing a chip selects and highlights that pin on the canvas and in the panel; the panel's
  **이 핀을 참조하는 문단** list jumps back to the block.
- **Stale detection** — editing a linked pin's type, title or body (or deleting it) raises a
  `stale` badge on the paragraphs that cite it. Moving a pin never does: an anchor is not part of
  what a sentence claims. A person either confirms the sentence (`확인 · 해제`, which re-baselines
  the link) or lets a proposal bring it up to date.
- **Proposal queue, individual decisions, attributed revert** — 시안 mode builds a single suggestion from the
  current pins or the stale blocks, shows it as a summary line plus before/after block patches,
  and changes nothing until **채택**. Adopting writes the patches and an `op_log.before`
  snapshot in the same transaction; **되돌리기** restores exactly those blocks from that snapshot,
  also as a ledger row, so the undo has an undo.
- **Six types, seven links, one traceability view (v1)** — 화면 · 핀 · 요구사항(req) · 정책(policy) ·
  계약(contract) · QA(qa) are joined only by `implements` · `governs` · `handles_edge` · `verifies` ·
  `references` · `derived_from` · `blocks`. The **그래프 · RTM** tab draws the six lanes, highlights
  orphan pins and orphan nodes, and keeps a link `suspect` (with the reason) after an endpoint is
  rewritten until a person acknowledges it. Selecting a node edits its title, body, state and links
  in place; pins stay read-only here and are edited in the studio, so every object has one writer.
- **L0 → L1 → L2 in the header** — `evaluateMaturityLevel` is a pure function: L0 needs a screen and
  a pin; L1 needs a paragraph citing a pin, zero `stale` citations and a requirement or policy that
  is actually linked; L2 needs a linked QA case plus a Figma frame (or a real publication). The
  badge opens the full checklist with the sentence that would move it up.
- **A pin-derived proposal** — `graph.proposal.create` reads the pins and drafts only what the graph
  does not already carry: a policy for a policy pin, a requirement for a behaviour, a QA case that
  would prove it, an edge handler or a contract where the pin is one. The card lists every draft and
  the links it will make; adopting creates all of them in one transaction and the revert removes the
  nodes and every link that touched them, both recorded in `op_log`.
- **AI 제안, two engines, one card** — the daemon calls an Anthropic Messages API or any
  OpenAI-compatible Chat Completions endpoint by `fetch` (a custom base URL is a first-class field,
  so a local model server or a test double is the same path). The answer is peeled out of its
  prose, validated against the protocol's draft schema, checked against the project's own pins and
  link ends, and filed as the same decision card: nothing is written until **채택**, and the same
  `op_log.before` **되돌리기** takes it back. No key anywhere → the rule extractor answers and the
  badge says so.
- **The key is a request, not a setting** — it travels in one body to the provider and is dropped;
  `AI 설정` keeps it in the window's memory, and `GET /api/ai` answers only whether the daemon's
  environment has one. A test reads the SQLite file afterwards and finds no trace.
- **`pnpm eval` · 30 Korean golden cases** — 정책 10 · 표/계약 10 · 예외 10, scored on schema
  validity, expected node types, expected link types, pin grounding, and how many drafts stand on a
  pin at all. `--mock` measures the fallback deterministically (what CI runs); `--live` measures a
  real model on the same cases.
- **Export, import, backup** — the daemon serves the whole project as a `spec-studio.bundle` JSON
  (`GET /api/projects/:id/export`); import remaps every id so a bundle can be opened beside the
  project it came from; `POST /api/projects/:id/backup` writes a consistent SQLite copy with
  `VACUUM INTO`.

## Quick start

Node 22.14+ (the store uses the runtime's own `node:sqlite`) and pnpm 9.15.4 (via corepack):

```bash
corepack enable          # pnpm 9.15.4
pnpm install

# terminal 1 — the daemon, which owns .data/spec-studio.db
pnpm daemon:build
pnpm daemon

# terminal 2 — the app
pnpm dev                 # http://127.0.0.1:5173
```

The app checks `http://127.0.0.1:8787/api/health` on load. If the daemon is not running it says
so and keeps the project in the browser instead; the two modes never mix in one session.

### Desktop app (Electron, D1)

The same app as a single window — no second terminal, no manual daemon:

```bash
pnpm daemon:build && pnpm --filter @spec-studio/web build
pnpm desktop              # window + daemon sidecar (random port, session token)
pnpm desktop:smoke        # boot/create → reboot/verify → renderer-path e2e
pnpm desktop:package:dir  # unsigned .app for local use (release/mac/arm64)
```

The shell forks `dist/daemon.mjs` as a utility process on a random port behind a
one-shot `x-daemon-token`; the renderer loads the web build over `app://`. See
`apps/desktop/README.md`.

Daemon environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEC_STUDIO_DB` | `.data/spec-studio.db` | the SQLite file it owns |
| `SPEC_STUDIO_PORT` | `8787` | loopback port |
| `SPEC_STUDIO_ORIGINS` | `http://localhost:5173`, `http://127.0.0.1:5173`, `:4173` pairs | CORS allow-list |
| `SPEC_STUDIO_SCHEMA_DIR` | beside the bundle (`dist/schema`) | where `schema.sql` lives |

Verification, the same commands CI runs:

```bash
pnpm typecheck           # tsc --noEmit across the workspace
pnpm test:unit           # vitest: core, protocol, store, publish, daemon API, ai client
pnpm test                # the unit tests plus `pnpm eval` — the gate CI runs
pnpm build               # vite production build + the daemon bundle
pnpm dep:check           # dependency-cruiser boundary rules
pnpm test:contract       # python3 test/contract/test_schema.py
pnpm eval                # the 30-case golden set, mock (rule) mode — no key, no network
pnpm eval:live           # the same cases against a real model (ANTHROPIC_API_KEY / OPENAI_API_KEY)
pnpm check               # all of the above, in order
```

`pnpm eval` rides the unit-test step on purpose: the workflow file is edited by a person, and the
golden set has to be a gate even before someone adds a line to `ci.yml`. Once the step exists,
`test` can drop back to `pnpm test:unit && pnpm eval` only if it stops being the only caller.

End-to-end, against a real daemon, a real SQLite file and a Confluence-shaped mock:

```bash
test/e2e/run_w3.sh       # W3 · pins + Confluence publish
test/e2e/run_w4.sh       # W4 · document ↔ pin, stale, decision card, revert
test/e2e/run_v1.sh       # v1 · six types, seven links, L0–L2, export/import, backup
test/e2e/run_p2.sh       # AI 제안 · mock model server, LLM badge, adopt, revert, key hygiene
                         # all need Playwright (Python) and a chromium binary
```

The runners build the app and serve it with Vite's preview server, so the browser loads the same
bundle that ships rather than the dev transform.

`run_w3.sh` loads the sample, registers a Figma link, creates three pins, verifies the rows in the
SQLite file, restarts the daemon and reloads, publishes, checks the page and three attachments on
the mock, and proves a second publish adds nothing.

`run_w4.sh` drives the same stack and checks, in order: a paragraph added and linked to a pin; the
chip selecting the pin and the pin panel jumping back to the paragraph; a pin edit raising the
`stale` badge; one proposal shown as one card; adopting it changing the text; reverting restoring
the pre-adoption text from `op_log.before`; the stale badge returning after the revert and a
manual `확인 · 해제` clearing it; then a reload and a daemon restart keeping the document, the
proposal and the ledger. Screenshots land in `downloads/` (the W4 preview is
`spec-studio-w4-preview.png`).

## Publishing to Confluence

The modal asks for the site URL, a Space ID or key, the account email and a personal API token
(profile → security → API tokens). The token is used for the request in front of it and is never
written to the database, `localStorage` or a log; address, space and email are remembered for the
next time.

| Step | API |
| --- | --- |
| Space key → id | `GET /wiki/api/v2/spaces?keys=…` |
| First publish | `POST /wiki/api/v2/pages` |
| Later publish | `PUT /wiki/api/v2/pages/:id` with the next version |
| Attachments | `POST /wiki/rest/api/content/:id/child/attachment` (new) or `…/:attachmentId/data` (update) |

What the page contains: the screen summary, the Figma frame link when one is registered, the three
tables (기능 · 정책 · 예외) with number, title, description and precondition, the gap notice, and
the three attachments as Confluence attachment links. The first line says the page is a one-way
copy.

### Why a second publish creates nothing

`spec_hash` is a SHA-256 of what a reader sees — screen, Figma link and every pin's number, type,
title, body and anchor. Timestamps are left out on purpose.

1. Same hash already recorded for this project + space → **skipped**, no request to Confluence.
2. New hash but a page is on record → **updated** in place (`version + 1`), attachments replaced.
3. No page on record → **created**, once.

`publish_record` keeps `(project_id, target, space_key, spec_hash, page_id, remote_url,
published_at)`, with a unique `(target, idem_key)` index behind the lookup, so the decision
survives a restart. The tests fix all four cases: create → same spec → daemon/store reopen →
edited pin.

## AI 제안 — and why it still asks

The model never edits a document. It answers with a draft, and the daemon turns that draft into
the card a person already decides on:

| | |
| --- | --- |
| Providers | `Anthropic` · `OpenAI 호환` (any base URL) · `로컬 규칙` |
| Wire | `fetch` only — no SDK, no dependency on a vendor library |
| Trust boundary | `AiGraphDraftSchema` / `AiDocDraftSchema` in `packages/protocol/src/ai.ts` |
| Evidence | a draft cites pin **numbers**; a number the screen does not have is dropped, not shown |
| Decision | one card, **채택** writes in one transaction, **되돌리기** restores `op_log.before` |
| Badge | `LLM 제안 · openai · gpt-4o-mini` or `로컬 규칙 폴백` |

`AI 설정` takes a provider, a model, an optional endpoint and a key, and keeps them in the
window's memory for the session. The key is sent in one request body, forwarded to the provider,
and never written to SQLite, `localStorage` or a log. When the field is empty the daemon falls back
to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from its own environment; when neither exists the rule
extractor builds the card and the badge says **로컬 규칙 폴백**, so a silent downgrade cannot be
mistaken for a model answer.

Two shapes, one card:

- **graph** — `req` · `policy` · `contract` · `qa` drafts with the seven named link types. The same
  `graph.proposal.create` command the rule extractor uses carries an optional `draft`; the store
  still validates link ends and writes the adoption and its undo as ledger rows.
- **doc** — paragraph patches. The `before` side is read from the document at the moment the card
  is filed, so a `되돌리기` puts back exactly the text that was there; the citation line is
  regenerated from the document's own pins, never from the model's prose.

### The golden set and its bar

`pnpm eval` scores 30 Korean cases — 정책 10, 표/계약 10, 예외 10 — and prints one row each plus
the totals:

| Column | Question |
| --- | --- |
| 스키마 | does the proposal still parse, with at least one draft? |
| 타입 | of the node types a good answer must carry, how many are there? |
| 링크 | of the link types it must carry, how many are there? |
| 핀근거 | of the pin numbers the sentence stands on, how many are cited? |
| 근거비율 | share of drafts that cite an existing pin at all — a hallucination shows up here |

Thresholds: schema 100%, types ≥85%, links ≥85%, pin grounding ≥90%, grounded drafts ≥90%.
`--mock` (the default without a key) measures the rule fallback and is what CI runs; `--live`
measures a real model on the same cases. Three cases are deliberately hard for the rules — a policy
written inside a `function` pin, a table inside a `function` pin, an exception inside a `function`
pin — and show up as 0% rows in mock mode, which is the gap a model is supposed to close.

## Repository layout

```
apps/
  web/                 React 19 + Vite shell — pins, document panel, outputs, publish modal
  daemon/              node:http API over the store; the only writer of the SQLite file
packages/
  protocol/            Zod: object kinds, pin types, screen refs, blocks, proposals, commands
  core/                Pure domain: pin numbering, blocks, stale, proposals, output generators
  store/               schema.sql (v14) · the SQLite adapter · publish records
  publish/             Confluence client, Storage-Format body, idempotent publish flow
  ai/                  provider calls by fetch, prompts, strict draft parsing — no store, no core
eval/
  golden/              30 Korean cases: policy 10 · table/contract 10 · exception 10
  src/                 the scorer (`pnpm eval`), mock and live modes
test/
  contract/            the SQLite schema contract (Python, no dependencies)
  e2e/                 the W3, W4 and v1 browser checks and their runners
```

Dependency direction is one-way:

```
apps/web → HTTP → apps/daemon → packages/{store → core → protocol}
                                   ↑
                     packages/publish ┘ (records arrive through a port)
```

### Five boundary rules

`.dependency-cruiser.cjs` fails the build when a rule is broken:

| Rule | What it prevents |
| --- | --- |
| `renderer-never-touches-store` | The web shell importing the store, daemon, MCP, publisher or AI client |
| `core-is-pure` | Node built-ins in core source — no fs, no http, no clock |
| `mcp-knows-no-schema` | MCP code reaching into the store |
| `publish-knows-no-schema` | The publisher reading the database; the daemon hands it records |
| `protocol-has-no-deps` | Protocol depending on anything but `zod` |
| `ai-is-a-service-not-a-layer` | The model client reading the store, running a command, or reaching into core |

`core-is-pure` is checked twice: dependency-cruiser sees imports, and
`packages/core/test/purity.test.ts` walks every file under `src/` for `Date.now()`,
`Math.random()` and `fetch()`.

## The daemon API

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, schema version, project count |
| `GET` · `POST` | `/api/projects` | list summaries · create |
| `GET` | `/api/projects/:id` | project (`screens`, `activeScreenId`, `screen`, `pins`, `docs`, `proposals`, `graph`, `graphProposal`) + publish records + what a revert would undo |
| `GET` | `/api/projects/:id/export` | the whole project as a `spec-studio.bundle` |
| `POST` | `/api/projects/import` | a bundle → a new project with every id remapped |
| `POST` | `/api/projects/:id/backup` | one consistent copy of the SQLite file (`VACUUM INTO`) |
| `POST` | `/api/projects/:id/commands` | apply one validated command; answers with `seq`, `opSeq` and events |
| `POST` | `/api/projects/:id/revert` | restore `op_log.before` of an adoption (`{ seq }`, latest by default) |
| `POST` | `/api/projects/:id/publish/preview` | plan (`create`/`update`/`skip`), body, attachments |
| `POST` | `/api/projects/:id/publish` | run the publish; receives the browser-rendered overlay |
| `GET` | `/api/projects/:id/publishes` | history |
| `GET` | `/api/ai` | which providers have an environment key (booleans only) |
| `POST` | `/api/ai/test` | one small call, for the settings panel's connection badge |
| `POST` | `/api/projects/:id/ai/proposal` | model draft → validated card; falls back to the rules |

Requests from an origin outside the allow-list are refused with 403. The API has no delete
route, and no endpoint accepts a credential in a query string.

## The object graph

Six types, but only two new node tables' worth of storage: requirements and policies are
`specnode` subtypes, QA is `verification`, and a graph contract is a `contract` with the `api`
subtype. The node kinds already existed in `schema.sql`; v1 made them reachable, and the migration
(`migrate-13-14.sql`) only adds the missing link types and the `graph_proposal` card table.

| Type | `obj.kind` | `subtype` |
| --- | --- | --- |
| 화면 `screen` | `screen` | — |
| 핀 `pin` | `pin` | the six pin types |
| 요구사항 `req` | `specnode` | `requirement` |
| 정책 `policy` | `specnode` | `policy` |
| 계약 `contract` | `contract` | `api` |
| QA `qa` | `verification` | — |

| Link | From → to | Means |
| --- | --- | --- |
| `implements` | screen/pin → req | this screen or pin carries out the requirement |
| `governs` | policy → screen/pin/req | the policy constrains it |
| `handles_edge` | pin/screen/req → req/policy | this edge case is handled here |
| `verifies` | qa → screen/pin/req/policy/contract | the QA case proves it |
| `references` | any → any | a plain citation, kept explicit rather than untyped |
| `derived_from` | req/policy/contract/qa → req/policy/contract/qa/pin | the source it was read from |
| `blocks` | req/policy/contract/qa/pin → req/policy/contract/qa/pin | it cannot proceed until the other is settled |

The `link_type` registry in SQLite holds the same `src_kinds`/`dst_kinds` lists and a trigger
refuses an edge whose ends do not fit, so an invalid link cannot be written even by a client that
skips the protocol. A rewritten pin or node keeps its edges but stamps `suspect_since` and
`suspect_why` on them; the RTM panel lists them until a person presses **확인**.

`evaluateMaturityLevel(project, { published })` is pure and lives in `packages/core/src/graph.ts`,
next to `traceability` and `extractGraphProposal` — the three rules the UI shows are the three
functions the unit tests drive without a database.

## The document, the proposal and the revert

A block is a paragraph-level piece of the document beside the screen. It has a stable `B_` id
because a proposal, a citation and a revert all have to name the same block before and after an
edit.

| Object | Table | Notes |
| --- | --- | --- |
| Document | `doc` | belongs to a project and the screen it describes, `rev` counts committed edits |
| Block | `block` | `idx` is the order, `attrs.pinRefs` lists the pins it stands on |
| Link | `block.attrs.pinRefs` | `{ pinId, fingerprint, linkedAt }` — `fingerprint` is the pin's type·title·body hash |
| Proposal | `proposal` / `proposal_op` | summary, `base_rev`, one row per patch with `before`/`after` |
| Undo | `op_log` | `before` holds a snapshot of every touched block, with its position |

**Stale** is derived, never stored: a link is `pin-changed` when the pin's current fingerprint
differs from the recorded one, and `pin-missing` when the pin is gone (its number is never reused,
so the sentence points at nothing). Confirming the badge writes the current fingerprint back;
deleting the pin instead means the citation is dropped.

**A proposal never touches the text.** `proposal.create` writes one `proposal` row and its
`proposal_op` rows; `proposal.adopt` applies them and writes one `op_log` row whose `before` is
the snapshot `snapshotForPatches` produced. `POST /revert` reads that `before`, restores the
blocks (`restoreSnapshot`), and appends a `proposal.revert` row carrying its own `before` — so a
revert is itself in the ledger and cannot be run twice.

`op_log.kind` uses the schema's ledger vocabulary (`block.create`, `block.update`,
`block.delete`, `block.move`, `block.pin.link`, `block.stale.clear`, `proposal.adopt`,
`proposal.revert`) rather than the command names, which is what lets the schema's
`before IS NOT NULL` constraint mean something for `block.update`, `block.delete` and
`proposal.adopt`.

## Pin numbering, precisely

| Rule | Behaviour |
| --- | --- |
| Numbers are immutable | Editing a pin's type, title or body never changes its number |
| No reuse | Deleting #3 leaves #3 empty; a new pin gets `max + 1` |
| Sorting is separate | The panel can sort by type or recency; the displayed number stays |
| Duplicated screens renumber | A copied screen is a new `S_`, so its pins get new numbers |

The implementation keeps a per-screen **high-water mark** (`pinSeq`). When state arrives from
outside, the mark is raised to the largest number present, never lowered — see
`packages/core/src/pins.ts` and `packages/core/test/pins.test.ts`.

## Outputs, and why each promise is testable

| Output | Promise | Where it is checked |
| --- | --- | --- |
| Overlay PNG | Markers sit on the unchanged screenshot at its own resolution | `buildOverlayMarkers` in core, canvas painting in `apps/web/src/model/overlay.ts` |
| Static HTML | Zero external requests; opens without the app | `renderStaticHtml` + a Playwright run that counts requests |
| QA CSV | BOM, CRLF, nine columns, case id stable across deletions | `buildQaCsv` + tests |

All three come from the same build, so the preview and the downloaded file cannot disagree — and
the publish path uploads the same three files.

## The store

`openSqliteStore({ file })` implements `StorePort` against `schema.sql` with the SQLite that ships
in Node (`node:sqlite`).

- **One command, one transaction.** The command runs through `@spec-studio/core` first, so the
  numbering rule has exactly one implementation; the resulting state is written and `COMMIT`ted
  with its events and `op_log` row.
- **Deletes are tombstones**, so the number a deleted pin was given stays in the file.
- **FTS5 is optional**; the adapter skips the marked section on builds without it.
- **Publish records are rows**, keyed by target and idempotency key, with a project owner.

`packages/store/schema/schema.sql` is the canonical DDL (SQLite, `user_version = 13`). Older files
are migrated in place when opened — `schema/migrate-11-12.sql` rebuilds `publish_record` so a row
can name a project, and `schema/migrate-12-13.sql` adds `doc.project_id` / `doc.screen_id` /
`doc.updated_at` and the block timestamps, all additive.

```bash
pnpm test:contract
# schema   4/ 4
# reject  28/28
# accept  16/16
# plan     4/ 4
# search   5/ 5
# v2       1/ 1
# PASS: schema contract holds
```

## Scope — what W4 does *not* do

- **Confluence only, one direction.** Notion and Jira are named in the schema, not implemented.
  Nothing is read back: editing the page does not change the local spec.
- **One screen per project.** The daemon holds many projects, but the UI opens one screen.
- **No capture, no states, no Figma import.** Pins are the only object type the UI creates, and
  the Figma frame is a link, never an embed.
- **The overlay must be rendered in a browser.** The daemon cannot composite a screenshot, so a
  publish request carries the PNG the app made; a Figma-only screen has no overlay to publish.
- **Search needs a build with FTS5.** Storing pins does not.
- **The document editor is paragraph-level.** Paragraph, heading, list and caption blocks are
  editable; tables, figures and code blocks exist in the schema but are not rendered yet, because
  an editor that cannot show them would delete them.
- **One document per screen.** A new screen brings a new document; the old one stays in the file
  with its blocks, not in the UI.
- **Document proposal queue.** Open suggestions stay visible together with source, block count,
  before/after preview and same-block conflict warnings. Each card can be adopted, rejected or
  deferred to the bottom. A changed base block blocks adoption instead of overwriting newer text.
  Queue order and decisions survive reopening SQLite; revert records the adopted proposal id.
- **Revert restores blocks, not pins.** Undoing an adoption returns the paragraphs to their
  pre-adoption text and links; the pin edit that caused it is not undone.

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Vite dev server on `127.0.0.1:5173` |
| `pnpm desktop` | Electron shell over the daemon + web build |
| `pnpm desktop:smoke` | Three-boot desktop e2e (create/verify/window) |
| `pnpm desktop:package:dir` | Unsigned `.app` via electron-builder `--dir` |
| `pnpm daemon:build` | Bundle the daemon to `apps/daemon/dist` |
| `pnpm daemon` | Run the daemon (`dist/daemon.mjs`) |
| `pnpm build` | Build the web app and the daemon bundle |
| `pnpm preview` | Serve the production build |
| `pnpm test` | Vitest across packages |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm dep:check` | Boundary rules |
| `pnpm test:contract` | SQLite schema contract |
| `pnpm check` | Everything CI runs |

## License

The core is **Apache-2.0** — the full text lives in the [LICENSE](LICENSE) file. 관리형 서비스(게이트웨이 · 클라우드 · 팀 기능)는 별도 서비스로 제공될 예정입니다. **BYOK(bring-your-own-key)는 항상 무료이며 기능 잠금이 없다** — 자신의 API 키를 그대로 가져오는 한, 어떤 기능도 요금제 뒤에 잠겨 있지 않습니다.

Copyright 2026 developjik. 루트와 워크스페이스 하위 패키지(`apps/*`, `packages/*`) 모두 [Apache License 2.0](LICENSE)을 따릅니다.


### Multi-screen projects (DEV49)

`GET /api/projects/:id` returns ordered `screens[]`, `activeScreenId`, all project
`pins[]` (join on `screenId`), and `screenPinSeq` high-water marks keyed by screen id.
`screen` remains an alias for the active screen and `pinSeq` is its derived counter.
Empty projects return `screens: []`, `activeScreenId: null`, `screen: null`.
Document `screenId` records ownership; changing screens never moves a document.
Graph/IA shows the whole project; the canvas, document tabs and RTM pin list use the
selected screen. Screen rail badges show pin counts and stale document references.

Commands use the existing `/commands` endpoint:

- `screen.add`: `{ screen: Screen, order?: number }`, zero-based insertion index.
  The full screen supplies title, unique code, image/ref and id. UI creates a blank
  image screen or adds an uploaded image. New screens become active.
- `screen.select`: `{ screenId }`, preserves all pins, documents and counters.
- `screen.reorder`: `{ screenIds: string[] }`, every live screen exactly once.
- `screen.delete`: `{ screenId }`, tombstones only that screen, its pins and docs;
  other counters keep their gaps. The next first screen becomes active if needed.
- Legacy `screen.attach` is an additive upsert/select alias, no longer a destructive
  screen replacement. Reattaching an existing screen preserves its counter.

DB schema is 17, because DEV120 already uses 16. Migration is additive:
15→16→17 preserves proposal history, existing screen props/counters and doc links.
Only active-screen id and order are added to the project row; screens, pins and
screen doc links retain their existing tables. Exports/imports remap every screen,
its pins, documents, graph references and counter keys.

Publish preview/run accept optional `screenId` (default: active screen). Both pin
and document payloads and successful page lookups are scoped to that screen.
The modal offers one screen or all, and all-screen publishing calls the existing
endpoint sequentially, rendering an overlay per screen. Pages and idempotency are
separate per screen. Partial success stays in history; a later failure does not
roll back pages already published. Automatic retry is safe for unchanged successful
screens. The all-screen preview explicitly shows only the first screen.

`test/e2e/run_screens.sh` exercises three UI-created screens, independent pin
numbers, switch/reload persistence and one all-screen action against a local mock
Confluence. It creates three distinct pages, not three updates of the same page.
No real Confluence account or external model is used by this test.

Graph proposals, including local rules, use the selected screen unless an explicit
request-time screenId is supplied to the graph.proposal.create command. The
/ai/proposal endpoint uses the active screen (or requested document owner), not a
separate screenId parameter. This prevents duplicate per-screen pin numbers
from crossing screens. Adoption rejects deleted link endpoints atomically.
Browser storage stores the active screenshot once and reconstructs the legacy
screen alias on load. Version 1 downloaded bundles keep the screen alias for older
readers, accepting image duplication for backward compatibility.
