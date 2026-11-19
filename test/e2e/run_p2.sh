#!/usr/bin/env bash
# Runs the AI proposal end-to-end check: mock model server + daemon + SQLite
# + Vite preview + Playwright.
# Usage: test/e2e/run_p2.sh   (from the repository root)
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK="${WORK:-$PWD/.e2e-p2}"
rm -rf "$WORK"
mkdir -p "$WORK"
export SPEC_STUDIO_DB="$WORK/graph.db"
export DAEMON_LOG="$WORK/daemon.log"
export OUT_DIR="${OUT_DIR:-$PWD/../../downloads}"
export MOCK_LLM_URL="${MOCK_LLM_URL:-http://127.0.0.1:8799}"

# The model double answers in both provider dialects; the daemon reaches it by
# the Endpoint a person types into AI 설정.
python3 test/e2e/mock_llm.py 8799 > "$WORK/mock-llm.log" 2>&1 &
MOCK_PID=$!

pnpm daemon:build > "$WORK/build.log" 2>&1

VITE_SPEC_STUDIO_DAEMON=http://127.0.0.1:8787 pnpm build > "$WORK/webbuild.log" 2>&1
VITE_SPEC_STUDIO_DAEMON=http://127.0.0.1:8787 pnpm --filter @spec-studio/web preview --port 5173 > "$WORK/vite.log" 2>&1 &
VITE_PID=$!

cleanup() {
  kill "$VITE_PID" 2>/dev/null || true
  kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 150); do
  if curl -fsS http://127.0.0.1:5173 > /dev/null 2>&1; then break; fi
  sleep 0.2
done

python3 test/e2e/w_p2.py
