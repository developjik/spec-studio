# End-to-end CI

Run `pnpm install --frozen-lockfile`, `python3 -m pip install -r test/e2e/requirements.txt`, and `python3 -m playwright install --with-deps chromium`, then `pnpm e2e`.

The command runs v1, W3 publishing, W4 documents, P2 proposals, E1 handoff, and F2/F3 research in order. Each uses a local daemon, SQLite and local mock services, with no live Confluence credentials or paid model calls. Ports 8787 and 5173 must be free for the older harnesses.

The wrapper builds the daemon once. CI caches that bundle by lockfile and daemon/package sources. Each harness still builds the web app with its selected daemon URL. `E2E_DAEMON_BUILT=1` reuses an existing daemon build, so omit it after changing daemon sources unless you rebuild first.

Each run creates a unique `run-*` folder beneath `.e2e-artifacts/`, or `E2E_ARTIFACTS` if set, preserving existing files. Each harness has a transcript, daemon/server logs, and screenshots. Browser exceptions capture a failure screenshot before teardown; failed assertions capture `failure-checks.png`. A daemon startup failure can only provide logs because no browser page exists yet. CI uploads the whole directory on failure for seven days. Process groups are terminated after each harness, including on error or timeout (four minutes per harness).

The E1 ledger checks wait up to five seconds for two committed export rows, because a browser download can finish before daemon bookkeeping. This does not relax the required row count.
