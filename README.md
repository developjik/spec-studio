# spec-studio

**AI-native specification studio** — the project lives in a local SQLite file, screens carry
immutable numbered pins, and handoff documents are generated as static outputs. External tools
receive copies; they are never the source of truth.

[![CI](https://github.com/developjik/spec-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/spec-studio/actions/workflows/ci.yml)

> **Status: W4.** The screen now has a document beside it. Paragraphs stand on the numbered pins
> in both directions, a paragraph whose pin facts moved goes `stale`, and a change can arrive as
> one proposal shown as a single decision card — adopted in one click, undone in one click from
> the `op_log.before` snapshot the store wrote. Publishing still copies a spec once per content
> hash.

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
- **One proposal, one decision card, one revert** — 시안 mode builds a single suggestion from the
  current pins or the stale blocks, shows it as a summary line plus before/after block patches,
  and changes nothing until **채택**. Adopting writes the patches and an `op_log.before`
  snapshot in the same transaction; **되돌리기** restores exactly those blocks from that snapshot,
  also as a ledger row, so the undo has an undo.

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
pnpm test                # vitest: core, protocol, store, publish, daemon API
pnpm build               # vite production build + the daemon bundle
pnpm dep:check           # dependency-cruiser boundary rules
pnpm test:contract       # python3 test/contract/test_schema.py
pnpm check               # all of the above, in order
```

End-to-end, against a real daemon, a real SQLite file and a Confluence-shaped mock:

```bash
test/e2e/run_w3.sh       # W3 · pins + Confluence publish
test/e2e/run_w4.sh       # W4 · document ↔ pin, stale, decision card, revert
                         # both need Playwright (Python) and a chromium binary
```

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

## Repository layout

```
apps/
  web/                 React 19 + Vite shell — pins, document panel, outputs, publish modal
  daemon/              node:http API over the store; the only writer of the SQLite file
packages/
  protocol/            Zod: object kinds, pin types, screen refs, blocks, proposals, commands
  core/                Pure domain: pin numbering, blocks, stale, proposals, output generators
  store/               schema.sql (v13) · the SQLite adapter · publish records
  publish/             Confluence client, Storage-Format body, idempotent publish flow
test/
  contract/            the SQLite schema contract (Python, no dependencies)
  e2e/                 the W3 and W4 browser checks and their runners
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
| `renderer-never-touches-store` | The web shell importing the store, daemon, MCP or publisher |
| `core-is-pure` | Node built-ins in core source — no fs, no http, no clock |
| `mcp-knows-no-schema` | MCP code reaching into the store |
| `publish-knows-no-schema` | The publisher reading the database; the daemon hands it records |
| `protocol-has-no-deps` | Protocol depending on anything but `zod` |

`core-is-pure` is checked twice: dependency-cruiser sees imports, and
`packages/core/test/purity.test.ts` walks every file under `src/` for `Date.now()`,
`Math.random()` and `fetch()`.

## The daemon API

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, schema version, project count |
| `GET` · `POST` | `/api/projects` | list summaries · create |
| `GET` | `/api/projects/:id` | project (screen, pins, `doc`, `proposal`) + publish records + what a revert would undo |
| `POST` | `/api/projects/:id/commands` | apply one validated command; answers with `seq`, `opSeq` and events |
| `POST` | `/api/projects/:id/revert` | restore `op_log.before` of an adoption (`{ seq }`, latest by default) |
| `POST` | `/api/projects/:id/publish/preview` | plan (`create`/`update`/`skip`), body, attachments |
| `POST` | `/api/projects/:id/publish` | run the publish; receives the browser-rendered overlay |
| `GET` | `/api/projects/:id/publishes` | history |

Requests from an origin outside the allow-list are refused with 403. The API has no delete
route, and no endpoint accepts a credential in a query string.

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
- **One proposal at a time.** A new suggestion replaces the open one; adopted and rejected
  proposals stay in `proposal` as history. There is no multi-proposal queue.
- **Revert restores blocks, not pins.** Undoing an adoption returns the paragraphs to their
  pre-adoption text and links; the pin edit that caused it is not undone.

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Vite dev server on `127.0.0.1:5173` |
| `pnpm daemon:build` | Bundle the daemon to `apps/daemon/dist` |
| `pnpm daemon` | Run the daemon (`dist/daemon.mjs`) |
| `pnpm build` | Build the web app and the daemon bundle |
| `pnpm preview` | Serve the production build |
| `pnpm test` | Vitest across packages |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm dep:check` | Boundary rules |
| `pnpm test:contract` | SQLite schema contract |
| `pnpm check` | Everything CI runs |
