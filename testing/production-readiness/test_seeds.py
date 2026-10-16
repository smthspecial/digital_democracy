import importlib.util
from datetime import date
from pathlib import Path
import sys
import subprocess
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parents[2] / 'infra/compose'
sys.path.insert(0, str(DIRECTORY))
spec = importlib.util.spec_from_file_location('local_seed', DIRECTORY / 'seed.py')
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
from seed_data import USERS, dataset, fixture_id, seed_sql


class FixtureTests(unittest.TestCase):
    def test_repeatable_ids_hashes_and_auth_boundaries(self):
        first = dataset('test-only-secret', date(2026, 10, 16))
        self.assertEqual(first, dataset('test-only-secret', date(2026, 10, 16)))
        self.assertEqual(len(first['api_ts']['citizen']), len(USERS))
        self.assertEqual(len({u['id'] for u in first['api_ts']['citizen']}), 22)
        self.assertNotIn('session', first['api_go'])
        self.assertNotIn('mfa_factor', first['api_go'])
        self.assertNotIn('ballot', first['api_go'])
        self.assertNotIn('audit_log', first['api_go'])
        hashes = {u['legal_identity_hash'] for u in first['api_ts']['citizen']}
        changed = {u['legal_identity_hash'] for u in dataset('another-secret')['api_ts']['citizen']}
        self.assertFalse(hashes & changed)
        self.assertEqual(fixture_id('citizen', 'alice'), 'f9ca34b4-28ba-5491-9dd4-b1e5aea78748')

    def test_sql_is_transactional_and_only_inserts(self):
        for tables in dataset('synthetic').values():
            sql = seed_sql(tables)
            self.assertTrue(sql.startswith('BEGIN;'))
            self.assertTrue(sql.endswith('COMMIT;\n'))
            self.assertNotIn('TRUNCATE', sql)
            self.assertNotIn('DELETE FROM', sql)
            self.assertIn('ON CONFLICT (id) DO NOTHING', sql)


class ResetSequencingTests(unittest.TestCase):
    def install(self, fail_database=None):
        commands = []

        def compose(engine, *args, **kwargs):
            commands.append(list(args))
            if fail_database and fail_database in args:
                raise subprocess.CalledProcessError(1, args)

        with patch.object(seed, 'load_settings', return_value={'IDENTITY_HASH_SECRET': 'synthetic'}), \
             patch.object(seed, 'compose', side_effect=compose), \
             patch.object(seed.subprocess, 'run'), patch.object(seed.local, 'wait_http'), \
             patch.dict(seed.os.environ, {}, clear=True):
            if fail_database:
                with self.assertRaises(subprocess.CalledProcessError):
                    seed.install('docker', reset=True)
            else:
                seed.install('docker', reset=True)
        return commands

    def test_reset_uses_volumes_and_seeds_both_databases_before_start(self):
        commands = self.install()
        self.assertEqual(commands[1], ['down', '--volumes', '--remove-orphans'])
        self.assertIn('api_ts', commands[3])
        self.assertIn('api_go', commands[4])
        self.assertEqual(commands[5][:2], ['up', '--detach'])

    def test_failed_seed_keeps_application_writers_stopped(self):
        commands = self.install(fail_database='api_go')
        self.assertEqual(commands[-1][0], 'exec')
        self.assertFalse(any(command[0] == 'up' for command in commands))

    def test_no_reset_before_configuration_and_fixture_validation(self):
        with patch.object(seed, 'load_settings', return_value={}), patch.object(seed, 'compose') as compose:
            with self.assertRaises(ValueError):
                seed.install('docker', reset=True)
        compose.assert_not_called()


if __name__ == '__main__':
    unittest.main()
