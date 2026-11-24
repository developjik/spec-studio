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

# Every port is picked at runtime — :8799, :8787 and :5173 are all taken on
# this host, and an ephemeral port proves nothing less. The daemon's CORS list
# still needs the web origin named explicitly.
pick_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
MOCK_PORT="$(pick_port)"
DAEMON_PORT="$(pick_port)"
WEB_PORT="$(pick_port)"
export MOCK_LLM_URL="http://127.0.0.1:${MOCK_PORT}"
export DAEMON_PORT
export WEB_URL="http://127.0.0.1:${WEB_PORT}"
export SPEC_STUDIO_ORIGINS="$WEB_URL"

# The model double answers in both provider dialects; the daemon reaches it by
# the Endpoint a person types into AI 설정.
python3 test/e2e/mock_llm.py "$MOCK_PORT" > "$WORK/mock-llm.log" 2>&1 &
MOCK_PID=$!

if [[ "${E2E_DAEMON_BUILT:-0}" != 1 ]]; then
  pnpm daemon:build > "$WORK/build.log" 2>&1
fi

VITE_SPEC_STUDIO_DAEMON="http://127.0.0.1:${DAEMON_PORT}" pnpm build > "$WORK/webbuild.log" 2>&1
VITE_SPEC_STUDIO_DAEMON="http://127.0.0.1:${DAEMON_PORT}" \
  pnpm --filter @spec-studio/web preview --port "$WEB_PORT" > "$WORK/vite.log" 2>&1 &
VITE_PID=$!

cleanup() {
  kill "$VITE_PID" 2>/dev/null || true
  kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 150); do
  if curl -fsS "$WEB_URL" > /dev/null 2>&1; then break; fi
  sleep 0.2
done

python3 test/e2e/w_p2.py
