# AGENTS.md — how an autonomous coding agent works in this repo

Spec Studio is an AI-native specification studio: the project lives in one local SQLite
file (`graph.db`), screens carry immutable numbered pins, and handoff documents are
generated as static outputs. External tools receive copies; they are never the source
of truth. Live demo: <https://developjik.github.io/spec-studio/>

This file is the onboarding for any autonomous agent (Devin Bot, Claude Code, Codex,
…) working here. It is deliberately short: everything below is checkable.

## Repo map

- `apps/web` — the studio UI. **UI strings are Korean on purpose — keep them.**
- `apps/daemon` — local daemon, the only writer of `graph.db` (binds 127.0.0.1).
- `apps/desktop` — Tauri desktop shell.
- `packages/` — `core` (graph model) · `store` (SQLite) · `protocol` · `ai` · `publish`.
- `eval/` — the golden set (30 Korean cases) and its runner.
- `test/contract` — SQLite schema contract tests · `test/e2e`.

## The one gate

```bash
pnpm install
pnpm check   # typecheck → eval typecheck → unit tests → build → dep:check → contract
```

`pnpm check` is the whole gate. CI runs it on every PR; a red `pnpm check` means the
PR is not ready, no exceptions. Focused extras: `pnpm eval` (golden set),
`pnpm test:contract` (schema stability).

## How work is picked up

1. Work arrives as GitHub issues labeled `impl` (see the *Impl phase* issue template).
   One issue = one implementable slice. Branch `agent/<issue-number>-<slug>` from `main`.
2. Implement the smallest coherent change that meets the issue's acceptance criteria.
   No drive-by refactors outside the issue scope. Never edit the schema contract
   without `pnpm test:contract` green and a note in the PR body.
3. Open a small, described PR linked to the issue. No force-push to `main`.
4. Issue ambiguous? Ask in the issue — an honest question beats a plausible wrong
   implementation.

## Standing duty — the intended Devin Bot role

Spec execution, not one-off tasks:

- watch the repo and sweep `impl`-labeled issues;
- per issue: implement → `pnpm check` → small tested PR → report back on the issue;
- run the loop continuously across releases; a human reviews every PR.

Everything the bot needs is this file: the gate command, the issue format, the branch
rules. A bot that can follow this file can own the loop.
