#!/usr/bin/env bash
# Runs the DEV120 queue end-to-end check: daemon + SQLite + Vite + Playwright.
# Usage: test/e2e/run_w4.sh   (from the repository root)
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK="${WORK:-$PWD/.e2e-queue}"
rm -rf "$WORK"
mkdir -p "$WORK"
export SPEC_STUDIO_DB="$WORK/graph.db"
export DAEMON_LOG="$WORK/daemon.log"
export OUT_DIR="${OUT_DIR:-$PWD/../../downloads}"

# The daemon bundle carries the schema beside it; build both before driving.
if [[ "${E2E_DAEMON_BUILT:-0}" != 1 ]]; then
  pnpm daemon:build > "$WORK/build.log" 2>&1
fi

# Serve the built app, not the dev transform: the check should exercise the
# bundle that ships, and the preview server is the same Vite.
VITE_SPEC_STUDIO_DAEMON=http://127.0.0.1:8787 pnpm --filter @spec-studio/web build > "$WORK/webbuild.log" 2>&1
VITE_SPEC_STUDIO_DAEMON=http://127.0.0.1:8787 pnpm --filter @spec-studio/web preview --port 5173 > "$WORK/vite.log" 2>&1 &
VITE_PID=$!

cleanup() {
  kill "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 150); do
  if curl -fsS http://127.0.0.1:5173 > /dev/null 2>&1; then break; fi
  sleep 0.2
done

python3 test/e2e/w_queue.py
