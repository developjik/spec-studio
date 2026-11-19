# spec-studio

**AI-native specification studio** — the project lives in a local SQLite file, screens carry
immutable numbered pins, and handoff documents are generated as static outputs. External tools
receive copies; they are never the source of truth.

[![CI](https://github.com/developjik/spec-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/spec-studio/actions/workflows/ci.yml)

> **Status: W2.** The browser app in `apps/web` edits and moves pins and produces the three
> handoff outputs. `packages/store` has a working SQLite adapter with round-trip tests; the web
> build still keeps its project in `localStorage`, because the renderer may not import the store.
> The daemon that connects the two is the next milestone.

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
- **Edit in place** — click a pin or its row to change its type, title and description. The
  number is not a field on the form, because it cannot change.
- **Move by dragging** — drag a marker on the screenshot and its `(x, y)` anchor follows the
  pointer; the number stays with it.
- **A pin panel that tells the truth** — filter by type, select, delete; deleted numbers appear
  as **결번** (gaps) and are never reused. The next number is always visible.
- **Three handoff outputs, built from one read of the pins**:
  1. **Overlay PNG** — the screenshot with numbered, type-coloured markers composited at the
     image's own resolution;
  2. **Static HTML** — one self-contained file: inline CSS, base64 image, the three tables and
     the gap notice. It opens from `file://` with **zero network requests**;
  3. **QA CSV** — UTF-8 with a BOM (so Excel reads `기능` correctly), CRLF, and the nine promised
     columns. `케이스ID` is derived from the pin number, so deleting a pin never renumbers a case.
- **A SQLite adapter** — `openSqliteStore()` reads and writes projects, screens and pins against
  `schema.sql`, applies every command through core in one transaction, records events and
  `op_log` rows, and keeps deleted pins as tombstones so the number survives in the file.
- **Local persistence in the app** — the project survives a reload in `localStorage`, and
  exports/imports as plain JSON.
- **Schema contract test** — 24 constraints that must reject bad data and 13 normal paths that
  must insert, run against real SQLite.

## Quick start

Node 22.14+ (the store uses the runtime's own `node:sqlite`) and pnpm 9.15.4 (via corepack):

```bash
corepack enable          # pnpm 9.15.4
pnpm install
pnpm dev                 # http://localhost:5173
```

Verification, the same commands CI runs:

```bash
pnpm typecheck           # tsc --noEmit across the workspace
pnpm test                # vitest: pin numbering, command semantics, purity, SQLite round trip
pnpm build               # vite production build
pnpm dep:check           # dependency-cruiser boundary rules
pnpm test:contract       # python3 test/contract/test_schema.py
pnpm check               # all of the above, in order
```

The contract test needs only Python 3 (standard library `sqlite3`).

## Repository layout

```
apps/
  web/                 React 19 + Vite shell — pins, editing, drag, the three outputs
packages/
  protocol/            Zod: object kinds, pin types, screen refs, commands, events
  core/                Pure domain: pin numbering, gap preservation, command execution,
                       output generators (tables · QA CSV · static HTML · marker layout)
  store/               schema.sql · the single writer · the SQLite adapter (node:sqlite)
test/
  contract/            the SQLite schema contract (Python, no dependencies)
```

Dependency direction is one-way:

```
apps/web → packages/core → packages/protocol
                ↑
packages/store ─┘        (holds the schema and the future write path)
```

### Four boundary rules

`.dependency-cruiser.cjs` fails the build when a rule is broken:

| Rule | What it prevents |
| --- | --- |
| `renderer-never-touches-store` | The web shell importing the store, daemon, MCP or publisher |
| `core-is-pure` | Node built-ins in core source — no fs, no http, no clock |
| `mcp-knows-no-schema` | MCP code reaching into the store |
| `protocol-has-no-deps` | Protocol depending on anything but `zod` |

`core-is-pure` is checked twice: dependency-cruiser sees imports, and
`packages/core/test/purity.test.ts` walks every file under `src/` (subdirectories included) for
`Date.now()`, `Math.random()` and `fetch()` — the things no import graph can catch. Time and ids
are arguments to every core function, `generatedAt` included.

## Pin numbering, precisely

| Rule | Behaviour |
| --- | --- |
| Numbers are immutable | Editing a pin's type, title or body never changes its number |
| No reuse | Deleting #3 leaves #3 empty; a new pin gets `max + 1` |
| Sorting is separate | The panel can sort by type or recency; the displayed number stays |
| Duplicated screens renumber | A copied screen is a new `S_`, so its pins get new numbers |
| Publishing carries both | Once publishing lands: images show the number, static HTML shows number + object id |

The implementation keeps a per-screen **high-water mark** (`pinSeq`) next to the pins. Using
only `max(number) + 1` would recycle the top number after deleting it, which is exactly the
reference-breaking case the rule exists to prevent. When state arrives from outside, the mark
is raised to the largest number present, never lowered —
see `packages/core/src/pins.ts` and `packages/core/test/pins.test.ts`.

## Outputs, and why each promise is testable

| Output | Promise | Where it is checked |
| --- | --- | --- |
| Overlay PNG | Markers sit on the unchanged screenshot at its own resolution | `buildOverlayMarkers` in core, canvas painting in `apps/web/src/model/overlay.ts` |
| Static HTML | Zero external requests; opens without the app | `renderStaticHtml` + a Playwright run that opens the downloaded file and counts requests |
| QA CSV | BOM, CRLF, nine columns, case id stable across deletions | `buildQaCsv` + tests |

All three come from the same `buildTextOutputs` / `buildOverlayMarkers` calls, so the preview in
the modal and the downloaded file cannot disagree.

## The store adapter

`openSqliteStore({ file })` implements `StorePort` against `schema.sql` with the SQLite that ships
in Node (`node:sqlite`) — no native build, no compiler in CI.

- **One command, one transaction.** The command runs through `@spec-studio/core` first, so the
  numbering rule has exactly one implementation; the resulting state is then written and
  `COMMIT`ted with its events and `op_log` row. A rejected command writes nothing.
- **Deletes are tombstones.** A deleted pin keeps its row with `deleted_at` set, so the number it
  was given is still in the file. `pinSeq` lives in the screen's `props` and is only ever raised.
- **FTS5 is optional.** Node's bundled SQLite has no FTS5, so the schema marks the search section
  with `-- @optional-fts5`. The adapter applies everything above the marker and skips the rest on
  builds without it (`SchemaInfo.fts5` records which happened). The contract test always applies
  the whole file.
- **Round trip.** `packages/store/test/sqlite.test.ts` writes a project, a screen and three pins,
  edits one, drags one, deletes one, adds one (#4, not #3), then reopens the file and reads the
  same state back.

`packages/store/schema/schema.sql` is the canonical DDL (SQLite, `user_version = 11`).

```bash
pnpm test:contract
# schema   2/ 2
# reject  24/24
# accept  13/13
# plan     4/ 4
# search   5/ 5
# v2       1/ 1
# PASS: schema contract holds
```

It proves, against a real database, that:

- a project row exists, and objects can name the project they belong to;
- a pin cannot exist without its screen, and its parent must be a screen;
- `obj.kind` cannot be updated, and objects with links cannot be physically deleted;
- proposal, state-definition and publish records enforce their state-specific columns;
- the promised indexes are actually used (`link_src`, `link_queue`, `block_doc`);
- Korean search works: trigram for 3+ syllables, bigram for the 2-syllable queries trigram
  cannot answer;
- `schema-v2.sql` (run · run_log · checkpoint) applies additively on top of v1.

The script exits non-zero on any mismatch, so a schema that quietly stops enforcing something
cannot pass CI.

## Scope — what W2 does *not* do yet

- **The daemon is not here.** The adapter works and is tested, but the browser app still persists
  to `localStorage`: `renderer-never-touches-store` forbids the other arrangement. Binding them
  needs the daemon.
- **No publishing.** Overlay, HTML and CSV are local files; Confluence is W3.
- **No capture, no states, no Figma import.** Pins are the only object type the UI creates.
- **No network calls at runtime.** A Figma URL is stored as a reference; the frame is not
  embedded and no request is made. Everything on screen is local.
- **One screen per project.** The numbering rule is per screen; W2 opens one at a time.
- **Search needs a build with FTS5.** Storing pins does not; the index simply stays empty when the
  SQLite build cannot create it.

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Vite dev server on port 5173 |
| `pnpm build` | Typecheck and build the web app |
| `pnpm preview` | Serve the production build |
| `pnpm test` | Vitest across packages |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm dep:check` | Boundary rules |
| `pnpm test:contract` | SQLite schema contract |
| `pnpm check` | Everything CI runs |
