import importlib.util
from pathlib import Path
import sys
import unittest
import tempfile
import json
from hashlib import sha256

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'infra/release'))
spec = importlib.util.spec_from_file_location('rollout', ROOT/'infra/release/rollout.py')
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class RolloutTests(unittest.TestCase):
    def test_changed_or_public_bundles_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            names = ('release.json', 'certificates.json', 'maintenance.json', 'migrations.json', 'runtimes.yaml')
            for name in names: (bundle/name).write_text('synthetic')
            (bundle/'checksums.json').write_text(json.dumps({name: sha256((bundle/name).read_bytes()).hexdigest() for name in names}))
            rollout.verify_bundle(bundle)
            (bundle/'runtimes.yaml').write_text('changed image')
            with self.assertRaises(ValueError): rollout.verify_bundle(bundle)
            bundle.chmod(0o755)
            with self.assertRaises(ValueError): rollout.verify_bundle(bundle)

    def run_case(self, fail=None):
        calls = []
        def execute(command):
            calls.append(' '.join(command))
            if fail and fail in calls[-1]: raise RuntimeError('synthetic failure')
        config = {'releaseId': 'test', 'migrationSecrets': {'api-go': 'go-admin', 'api-ts': 'ts-admin'}}
        try: rollout.coordinate(config, Path('/bundle'), Path('/hooks'), execute)
        except RuntimeError: pass
        return calls

    def test_success_has_both_migration_and_readiness_gates(self):
        calls = self.run_case()
        def index(value): return next(i for i, command in enumerate(calls) if value in command)
        self.assertLess(index('/maintenance.json'), index('/hooks/drain'))
        self.assertLess(index('/hooks/drain'), index('/migrations.json'))
        for app in ('api-go', 'api-ts'):
            self.assertLess(index(f'job/test-{app}-migrate'), index('/runtimes.yaml'))
            self.assertLess(index(f'deployment/{app}'), index('/hooks/verify'))
        self.assertLess(index('/hooks/verify'), index('/hooks/revoke'))
        self.assertLess(index('/hooks/revoke'), index('delete secret go-admin'))
        self.assertEqual(calls[-1], 'kubectl delete -f /bundle/maintenance.json')

    def test_failures_stop_promotion_and_keep_traffic_paused(self):
        for failure in ('/hooks/drain', 'job/test-api-ts-migrate', 'deployment/api-ts', '/hooks/verify', '/hooks/revoke', '/hooks/resume'):
            calls = self.run_case(failure)
            self.assertTrue(calls[-1].endswith(failure) or failure in calls[-1])
            self.assertNotIn('kubectl delete -f /bundle/maintenance.json', calls)
            if 'migrate' in failure:
                self.assertFalse(any('/runtimes.yaml' in call for call in calls))


if __name__ == '__main__': unittest.main()
