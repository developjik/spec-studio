# spec-studio

**AI-native specification studio** — the project lives in a local SQLite file, screens carry
immutable numbered pins, and handoff documents are generated as static outputs. External tools
receive copies; they are never the source of truth.

[![CI](https://github.com/developjik/spec-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/spec-studio/actions/workflows/ci.yml)

> **Status: W1 prototype.** The browser app in `apps/web` is the first-week entry point. The
> SQLite schema and its contract tests are in place; the daemon and the store adapter are the
> next milestone. See [Scope](#scope--what-w1-does-not-do-yet).

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
- **A pin panel that tells the truth** — filter by type, select, delete; deleted numbers appear
  as **결번** (gaps) and are never reused. The next number is always visible.
- **Local persistence** — the project survives a reload in `localStorage`, and exports/imports
  as plain JSON.
- **Schema contract test** — 23 constraints that must reject bad data and 11 normal paths that
  must insert, run against real SQLite.

## Quick start

Node 20.19+ and pnpm 9.15.4 (via corepack):

```bash
corepack enable          # pnpm 9.15.4
pnpm install
pnpm dev                 # http://localhost:5173
```

Verification, the same commands CI runs:

```bash
pnpm typecheck           # tsc --noEmit across the workspace
pnpm test                # vitest: pin numbering, command semantics, core purity
pnpm build               # vite production build
pnpm dep:check           # dependency-cruiser boundary rules
pnpm test:contract       # python3 test/contract/test_schema.py
pnpm check               # all of the above, in order
```

The contract test needs only Python 3 (standard library `sqlite3`).

## Repository layout

```
apps/
  web/                 React 19 + Vite shell — the W1 entry point
packages/
  protocol/            Zod: object kinds, pin types, screen refs, commands, events
  core/                Pure domain: pin numbering, gap preservation, command execution
  store/               schema.sql · the single-writer port (adapter lands in W2)
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
`packages/core/test/purity.test.ts` sees `Date.now()`, `Math.random()` and `fetch()` — the
things no import graph can catch. Time and ids are arguments to every core function.

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

## The schema contract

`packages/store/schema/schema.sql` is the canonical DDL (SQLite, `user_version = 11`).

```bash
pnpm test:contract
# schema   2/ 2
# reject  23/23
# accept  11/11
# plan     4/ 4
# search   5/ 5
# v2       1/ 1
# PASS: schema contract holds
```

It proves, against a real database, that:

- a pin cannot exist without its screen, and its parent must be a screen;
- `obj.kind` cannot be updated, and objects with links cannot be physically deleted;
- proposal, state-definition and publish records enforce their state-specific columns;
- the promised indexes are actually used (`link_src`, `link_queue`, `block_doc`);
- Korean search works: trigram for 3+ syllables, bigram for the 2-syllable queries trigram
  cannot answer;
- `schema-v2.sql` (run · run_log · checkpoint) applies additively on top of v1.

The script exits non-zero on any mismatch, so a schema that quietly stops enforcing something
cannot pass CI.

## Scope — what W1 does *not* do yet

- **No SQLite runtime adapter.** The browser prototype persists to `localStorage`. The schema
  and its contract are authoritative; `StorePort` in `packages/store` is the shape the adapter
  will implement.
- **No daemon, no capture, no static export.** Pins are the only object type the UI creates.
- **No network calls at runtime.** A Figma URL is stored as a reference; the frame is not
  embedded and no request is made. Everything on screen is local.
- **One screen per project.** The numbering rule is per screen; W1 opens one at a time.

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
