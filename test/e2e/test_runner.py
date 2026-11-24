import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

MODULE = Path(__file__).with_name('run_all.py')


class RunnerTests(unittest.TestCase):
    def test_exit_status_and_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'test/e2e').mkdir(parents=True)
            (root / 'test/e2e/run_probe.sh').write_text('echo sentinel; exit 17\n')
            os.environ['E2E_ARTIFACTS'] = directory
            spec = importlib.util.spec_from_file_location('runner', MODULE)
            runner = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runner)
            runner.ROOT = root
            self.assertEqual(runner.run_harness('probe'), 17)
            self.assertIn('sentinel', (root / 'probe.log').read_text())

    def test_artifact_root_preserves_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'v1').mkdir()
            sentinel = root / 'v1/keep.txt'
            sentinel.write_text('keep')
            shell = Path(__file__).with_name('run_all.sh').read_text()
            # Exercise the actual root-selection prefix without running browsers.
            prefix = shell.split('if [[ "${E2E_DAEMON_BUILT:-0}"')[0]
            result = subprocess.run(['bash', '-c', prefix + '\nprintf "%s" "$E2E_ARTIFACTS"'],
                                    env={**os.environ, 'E2E_ARTIFACTS': directory},
                                    capture_output=True, text=True, check=True)
            selected = Path(result.stdout.splitlines()[-1])
            self.assertTrue(selected.name.startswith('run-'))
            self.assertEqual(selected.parent, root)
            self.assertEqual(sentinel.read_text(), 'keep')

    def test_mktemp_failure_stops_before_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'bin'
            binary.mkdir()
            fake = binary / 'mktemp'
            fake.write_text('#!/bin/sh\nexit 23\n')
            fake.chmod(0o755)
            shell = Path(__file__).with_name('run_all.sh').read_text()
            prefix = shell.split('if [[ "${E2E_DAEMON_BUILT:-0}"')[0]
            result = subprocess.run(['bash', '-c', prefix + '\necho SHOULD_NOT_RUN'],
                                    env={**os.environ, 'E2E_ARTIFACTS': str(root / 'output'),
                                         'PATH': str(binary) + os.pathsep + os.environ['PATH']},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 23)
            self.assertNotIn('SHOULD_NOT_RUN', result.stdout)

    def test_sigterm_cleans_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'test/e2e').mkdir(parents=True)
            (root / 'test/e2e/run_v1.sh').write_text('sleep 60 &\necho $! > child.pid\nwait\n')
            source = root / 'runner.py'
            source.write_text(MODULE.read_text().replace('ROOT = Path(__file__).resolve().parents[2]', 'ROOT = Path(__file__).resolve().parent'))
            process = subprocess.Popen([sys.executable, str(source)], env={**os.environ, 'E2E_ARTIFACTS': directory})
            try:
                deadline = time.monotonic() + 5
                while not (root / 'child.pid').exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((root / 'child.pid').exists())
                child = int((root / 'child.pid').read_text())
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=5), 143)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    stat = Path(f'/proc/{child}/stat')
                    try:
                        state = stat.read_text().split()[2]
                    except FileNotFoundError:
                        break
                    if state == 'Z':
                        break
                    time.sleep(0.02)
                else:
                    self.fail('child process survived SIGTERM cleanup')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    unittest.main()
