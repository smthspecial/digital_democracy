"""Scan exact local images and smoke-test them with disposable database roles."""
import argparse
import importlib.util
import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gate', ROOT/'infra/release/image-gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def status(base, path, method='GET'):
    try:
        request = urllib.request.Request(base+path, data=b'{}' if method == 'POST' else None, method=method, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=2) as response: return response.status
    except urllib.error.HTTPError as error: return error.code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trivy', required=True)
    args = parser.parse_args()
    fixture = json.loads(Path(Path('/tmp/dd-readiness-db-fixture-path').read_text()).read_text())
    output = ROOT/'testing/production-readiness/images'
    output.mkdir(exist_ok=True)
    reports, checks = [], []
    for app in ('api-go', 'api-ts', 'api-ts-migration', 'web'):
        image = f'localhost/dd-readiness-{app}:20261008'
        identity = json.loads(subprocess.check_output(['podman', 'image', 'inspect', image], text=True))[0]
        archive = f'/tmp/dd-readiness-final-{app}.tar'
        Path(archive).unlink(missing_ok=True)
        subprocess.run(['podman', 'save', '--format', 'docker-archive', '-o', archive, image], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        report_path = output/f'{app}-scan.json'
        with open(f'/tmp/dd-readiness-{app}-scan.log', 'w') as log:
            subprocess.run([args.trivy, 'image', '--input', archive, '--scanners', 'vuln', '--format', 'json', '--output', str(report_path), '--timeout', '10m'], check=True, stdout=log, stderr=log)
        report = json.loads(report_path.read_text())
        digest = 'sha256:'+identity['Id'].removeprefix('sha256:')
        assert report['Metadata']['ImageID'] == digest, 'Scanner image identity mismatch'
        result = gate.evaluate(report, json.loads((ROOT/'testing/security/image-advisory-reviews.json').read_text()))
        (output/f'{app}-gate.json').write_text(json.dumps(result, indent=2)+'\n')
        reports.append({'image': image, 'imageConfigDigest': digest, 'registryDigest': None, 'user': identity['Config']['User'], 'gatePassed': result['passed'], 'blocking': len(result['blocking']), 'reviewRequired': len(result['reviewRequired'])})
        assert result['passed'], f'{app} image gate failed; inspect retained raw report'
        user = identity['Config']['User']
        assert user not in ('', '0', 'root')
        checks.append({'case': f'{app} non-root', 'passed': True})
        subprocess.run(['podman', 'run', '--rm', '--entrypoint', 'sh', image, '-c', 'test ! -e /usr/local/lib/node_modules/npm && test ! -e /root/.cache/node/corepack'], check=True, stdout=subprocess.DEVNULL)
        if app.startswith('api-ts'):
            subprocess.run(['podman', 'run', '--rm', '--entrypoint', 'sh', image, '-c', 'test ! -e /src/apps/api-ts/src && test ! -e /src/apps/api-ts/dist/test-support && test ! -e /src/apps/api-ts/.env.example'], check=True, stdout=subprocess.DEVNULL)
            checks.append({'case': f'{app} excludes test source and fixtures', 'passed': True})
        if app == 'api-ts-migration': continue
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        name = f'dd-readiness-smoke-{app}-20261008'
        env = {'PORT': str(port), 'LISTEN_HOST': '127.0.0.1', 'APP_ENV': 'development'}
        suffix = f'@localhost:{fixture["port"]}/' + ('api_go' if app == 'api-go' else 'api_ts') + '?sslmode=verify-full&sslrootcert=/etc/dd/database/ca.crt'
        if app == 'api-go': env.update(DATABASE_URL='postgres://api_go_worker:disposable_go'+suffix, AUDIT_SIGNING_KEY='disposable-audit-seed-32-characters', INTERNAL_SERVICE_SHARED_SECRET='disposable-internal-service-key')
        if app == 'api-ts': env.update(DATABASE_URL='postgres://api_ts_app:disposable_app'+suffix, WORKER_DATABASE_URL='postgres://api_ts_worker:disposable_worker'+suffix, INTERNAL_SERVICE_SHARED_SECRET='disposable-internal-service-key', IDENTITY_HASH_SECRET='disposable-identity-hash-key')
        command = ['podman', 'run', '-d', '--name', name, '--network', 'host', '-v', f'{fixture["privateDirectory"]}/tls:/etc/dd/database:ro']
        for key, value in env.items(): command += ['-e', f'{key}={value}']
        command += [image]
        if app == 'web': command += ['node', 'apps/web/node_modules/next/dist/bin/next', 'start', 'apps/web', '--hostname', '127.0.0.1', '--port', str(port)]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    if status(base, '/' if app == 'web' else '/readyz') == 200: break
                except OSError: pass
                time.sleep(.1)
            else: raise AssertionError(f'{app} failed startup')
            checks.append({'case': f'{app} ready' if app == 'web' else f'{app} ready with restricted TLS database roles', 'passed': True})
            if app != 'web':
                path = '/audit/log' if app == 'api-go' else '/identity/duplicates/scan'
                assert status(base, path, 'POST' if app == 'api-go' else 'GET') == 401
                checks.append({'case': f'{app} denies unauthenticated worker request', 'passed': True})
        finally:
            with open(f'/tmp/dd-readiness-smoke-{app}.log','w') as log:
                subprocess.run(['podman','logs',name],stdout=log,stderr=subprocess.STDOUT)
            subprocess.run(['podman','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
    (output/'summary.json').write_text(json.dumps({'images': reports, 'checks': checks, 'passed': len(checks), 'scope': 'exact local artifact scans and disposable startup; no registry publication or production mesh qualification'}, indent=2)+'\n')
    print(f'4 exact-image gates and {len(checks)} container checks passed')


if __name__ == '__main__': main()
