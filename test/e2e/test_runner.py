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
                    if not stat.exists() or stat.read_text().split()[2] == 'Z':
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
