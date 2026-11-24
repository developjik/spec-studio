#!/usr/bin/env bash
# Six sequential local/mock harnesses. Each process group is cleaned on exit.
set -euo pipefail
cd "$(dirname "$0")/../.."
ARTIFACTS="${E2E_ARTIFACTS:-$PWD/.e2e-artifacts}"
mkdir -p "$ARTIFACTS"
export E2E_ARTIFACTS="$(mktemp -d "$(cd "$ARTIFACTS" && pwd)/run-XXXXXX")"
echo "Artifacts: $E2E_ARTIFACTS"
if [[ "${E2E_DAEMON_BUILT:-0}" != 1 ]]; then
  pnpm daemon:build > "$E2E_ARTIFACTS/daemon-build.log" 2>&1
fi
export E2E_DAEMON_BUILT=1
exec python3 test/e2e/run_all.py
