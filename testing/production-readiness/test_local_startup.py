import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'local_startup', Path(__file__).resolve().parents[2] / 'infra/compose/local.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class MigrationFailureTests(unittest.TestCase):
    def assert_stops_after(self, failed_job):
        commands = []

        def execute(command, **kwargs):
            commands.append(command)
            if command[-1] == failed_job and 'run' in command:
                raise subprocess.CalledProcessError(23, command)

        with patch.object(local, 'initialize'), patch.object(local.os, 'chdir'), \
                patch.object(local.subprocess, 'run', side_effect=execute), \
                patch('sys.argv', ['local.py', 'up', '--engine', 'docker']):
            with self.assertRaises(subprocess.CalledProcessError):
                local.main()
        # Infrastructure may run; no API/web launch may follow a failed job.
        self.assertFalse(any('up' in c and 'api-go' in c for c in commands))
        self.assertFalse(any('up' in c and 'api-ts' in c for c in commands))
        self.assertEqual(commands[-1][-1], failed_job)
        return commands

    def test_go_failure_prevents_prisma_and_runtime_launch(self):
        commands = self.assert_stops_after('api-go-migrate')
        self.assertFalse(any('run' in c and 'api-ts-migrate' in c for c in commands))

    def test_prisma_failure_prevents_runtime_launch(self):
        commands = self.assert_stops_after('api-ts-migrate')
        self.assertTrue(any('run' in c and 'api-go-migrate' in c for c in commands))


if __name__ == '__main__':
    unittest.main()
