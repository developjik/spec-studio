"""Keep each harness and its servers in a separate, always-cleaned process group."""
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(os.environ['E2E_ARTIFACTS'])
HARNESSES = ('v1', 'w3', 'w4', 'p2', 'e1', 'f2f3')


def run_harness(name):
    work = ARTIFACTS / name
    env = {**os.environ, 'WORK': str(work), 'OUT_DIR': str(work / 'screenshots')}
    print(f'=== e2e: {name} ===', flush=True)
    process = None
    try:
        with (ARTIFACTS / f'{name}.log').open('w') as log:
            process = subprocess.Popen(['bash', f'test/e2e/run_{name}.sh'], cwd=ROOT,
                                       env=env, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            return process.wait(timeout=240)
    except subprocess.TimeoutExpired:
        print(f'FAIL: {name} timed out after 240 seconds', flush=True)
        return 124
    finally:
        if process is not None:
            # pnpm may leave Vite grandchildren after its shell exits.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        log_file = ARTIFACTS / f'{name}.log'
        if log_file.exists():
            print(log_file.read_text(), end='', flush=True)


def main():
    for name in HARNESSES:
        code = run_harness(name)
        if code:
            print(f'FAIL: {name} exited {code}; artifacts: {ARTIFACTS}', flush=True)
            return code
    print('PASS: all six e2e harnesses', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
