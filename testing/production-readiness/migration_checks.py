"""Exercise both real migration images against the disposable TLS fixture."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    fixture = json.loads(Path(Path('/tmp/dd-readiness-db-fixture-path').read_text()).read_text())
    directory = Path(fixture['privateDirectory'])/'tls'
    checks = []
    for app in ('api-go', 'api-ts'):
        db = 'api_go' if app == 'api-go' else 'api_ts'
        image = f'localhost/dd-readiness-{app if app == "api-go" else "api-ts-migration"}:20261008'
        identity = json.loads(subprocess.check_output(['podman', 'image', 'inspect', image], text=True))[0]['Id']
        for case, host, ca, tls, expected in [('verified migration', 'localhost', 'ca', True, 0), ('wrong host', '127.0.0.1', 'ca', True, 1), ('wrong CA', 'localhost', 'wrong-ca', True, 1), ('plaintext configuration', 'localhost', 'ca', False, 1), ('ambiguous TLS configuration', 'localhost', 'ca', True, 1)]:
            query = f'sslmode=verify-full&sslrootcert=/etc/dd/database/{ca}.crt' if app == 'api-go' else f'sslmode=require&sslaccept=strict&sslcert=/etc/dd/database/{ca}.crt'
            if not tls: query = 'sslmode=disable'
            if case == 'ambiguous TLS configuration': query += '&sslmode=disable'
            url = f'postgres://dd:disposable_admin@{host}:{fixture["port"]}/{db}?{query}'
            command = ['podman', 'run', '--rm', '--network', 'host', '-v', f'{directory}:/etc/dd/database:ro', '-e', 'APP_ENV=production', '-e', f'MIGRATE_DATABASE_URL={url}']
            if app == 'api-go': command += ['-e', 'MIGRATE_ONLY=1']
            command += [image]
            result = subprocess.run(command, capture_output=True, text=True, timeout=45)
            Path(f'/tmp/dd-readiness-{app}-{case.replace(" ", "-")}.log').write_text(result.stdout+result.stderr)
            assert (result.returncode == 0) == (expected == 0), f'{app} {case} had unexpected exit {result.returncode}'
            checks.append({'runtime': app, 'case': case, 'passed': True, 'imageConfigDigest': identity})
    report = {'checks': checks, 'passed': len(checks), 'scope': 'separate real migration images on disposable TLS databases; not a live Kubernetes Job rehearsal'}
    (ROOT/'testing/production-readiness/migration-results.json').write_text(json.dumps(report, indent=2)+'\n')
    print(f'{len(checks)} migration TLS checks passed')


if __name__ == '__main__': main()
