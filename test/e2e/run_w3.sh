#!/usr/bin/env bash
# Runs the W3 end-to-end check: mock Confluence + daemon + Vite + Playwright.
# Usage: test/e2e/run_w3.sh   (from the repository root)
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK="${WORK:-$PWD/.e2e}"
rm -rf "$WORK"
mkdir -p "$WORK"
export SPEC_STUDIO_DB="$WORK/graph.db"
export MOCK_STATE_FILE="$WORK/mock.json"
export DAEMON_LOG="$WORK/daemon.log"
export OUT_DIR="${OUT_DIR:-$PWD/../../downloads}"

apps/daemon/node_modules/.bin/esbuild \
  packages/publish/src/testing/mock-confluence-main.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$WORK/mock.mjs" >/dev/null

node "$WORK/mock.mjs" > "$MOCK_STATE_FILE" 2>"$WORK/mock.log" &
MOCK_PID=$!

VITE_SPEC_STUDIO_DAEMON=http://127.0.0.1:8787 pnpm dev > "$WORK/vite.log" 2>&1 &
VITE_PID=$!

cleanup() {
  kill "$MOCK_PID" "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  if grep -q '"url"' "$MOCK_STATE_FILE" 2>/dev/null; then break; fi
  sleep 0.1
done
for _ in $(seq 1 100); do
  if curl -fsS http://127.0.0.1:5173 > /dev/null 2>&1; then break; fi
  sleep 0.2
done

python3 test/e2e/w3_publish.py
