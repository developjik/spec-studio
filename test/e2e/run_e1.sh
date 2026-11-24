#!/usr/bin/env bash
# Runs the E1 spine end-to-end check: mock model server + daemon + SQLite +
# Vite preview + Playwright — capture → brief → promote → graph proposal →
# F4 handoff package → idempotent re-export.
# Usage: test/e2e/run_e1.sh   (from the repository root)
# Artifacts (zips, manifest, daemon log) persist in .e2e-e1/ — printed at exit.
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK="${WORK:-$PWD/.e2e-e1}"
rm -rf "$WORK"
mkdir -p "$WORK"
export SPEC_STUDIO_DB="$WORK/graph.db"
export DAEMON_LOG="$WORK/daemon.log"
export OUT_DIR="${OUT_DIR:-$WORK}"

# Every port is picked at runtime — :8799 and :5173 are taken on this host,
# and an ephemeral port proves the flow is not hard-wired to them.
pick_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
MOCK_PORT="$(pick_port)"
DAEMON_PORT="$(pick_port)"
WEB_PORT="$(pick_port)"
export MOCK_LLM_URL="http://127.0.0.1:${MOCK_PORT}"
export DAEMON_PORT
export WEB_URL="http://127.0.0.1:${WEB_PORT}"
# The daemon's CORS list defaults to :5173/:4173 — the dynamic web port has to
# be named or every fetch answers 403 origin_not_allowed.
export SPEC_STUDIO_ORIGINS="$WEB_URL"

# The model double answers in both provider dialects; the daemon reaches it by
# the Endpoint a person types into AI 설정.
python3 test/e2e/mock_llm.py "$MOCK_PORT" > "$WORK/mock-llm.log" 2>&1 &
MOCK_PID=$!

if [[ "${E2E_DAEMON_BUILT:-0}" != 1 ]]; then
  pnpm daemon:build > "$WORK/build.log" 2>&1
fi

VITE_SPEC_STUDIO_DAEMON="http://127.0.0.1:${DAEMON_PORT}" pnpm --filter @spec-studio/web build > "$WORK/webbuild.log" 2>&1
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

python3 test/e2e/w_e1.py
STATUS=$?

echo "run dir: $WORK"
ls -la "$WORK"
exit $STATUS
