import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare', ROOT/'infra/release/prepare.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def config():
    result = json.loads((ROOT/'infra/release/release.example.json').read_text())
    result['context'] = 'synthetic-staging'
    result['images'] = {app: f'registry.example.org/{app}@sha256:' + 'a'*64 for app in ('api-go', 'api-ts', 'api-ts-migration')}
    return result


class ReleaseTests(unittest.TestCase):
    def test_example_fails_closed(self):
        with self.assertRaises(ValueError):
            prepare.validate(json.loads((ROOT/'infra/release/release.example.json').read_text()))

    def test_mutable_images_and_runtime_admin_credentials_rejected(self):
        for app in ('api-go', 'api-ts', 'api-ts-migration'):
            value = config()
            value['images'][app] = 'registry.example.org/image:latest'
            with self.assertRaises(ValueError): prepare.validate(value)
        value = config()
        value['migrationSecrets']['api-go'] = 'api-ts-runtime'
        with self.assertRaises(ValueError): prepare.validate(value)

    def test_jobs_have_no_runtime_or_shared_broker_secrets(self):
        value = config()
        prepare.validate(value)
        for app in ('api-go', 'api-ts'):
            policy, job = prepare.migration_resources(value, app)
            pod = job['spec']['template']['spec']
            self.assertFalse(pod['automountServiceAccountToken'])
            self.assertEqual(job['spec']['backoffLimit'], 0)
            self.assertEqual(job['spec']['template']['metadata']['annotations']['sidecar.istio.io/inject'], 'false')
            self.assertEqual(pod['containers'][0]['env'][0]['valueFrom']['secretKeyRef']['name'], f'{app}-migration-temporary')
            self.assertEqual(policy['spec']['ingress'], [])
            self.assertEqual(policy['spec']['egress'][0]['ports'][0]['port'], 5432)
            self.assertNotIn('api-go-runtime', json.dumps(job))

    def test_maintenance_denies_gateway_mutations_only(self):
        policy = prepare.maintenance_resource(config(), 'api-go')
        self.assertEqual(policy['spec']['action'], 'DENY')
        rule = policy['spec']['rules'][0]
        self.assertNotIn('GET', rule['to'][0]['operation']['methods'])
        self.assertEqual(rule['from'][0]['source']['principals'], ['cluster.local/ns/kube-system/sa/traefik'])


if __name__ == '__main__': unittest.main()
