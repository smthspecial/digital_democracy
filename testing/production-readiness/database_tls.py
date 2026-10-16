"""Disposable TLS-only PostgreSQL fixture; uses no existing databases/volumes.

Keep the fixture only when --keep is given to run the integration suites.
Private keys/passwords stay in a private temporary directory outside the repo.
"""
import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = 'dd-readiness-postgres-20261008'


def run(*command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keep', action='store_true')
    args = parser.parse_args()
    private = Path(tempfile.mkdtemp(prefix='dd-readiness-db-'))
    certs = private/'tls'
    certs.mkdir(mode=0o755)
    for ca in ('ca', 'wrong-ca'):
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', f'/CN=disposable-{ca}', '-keyout', str(private/f'{ca}.key'), '-out', str(certs/f'{ca}.crt'))
    run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', str(certs/'server.key'), '-out', str(private/'server.csr'))
    (private/'extensions').write_text('subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n')
    run('openssl', 'x509', '-req', '-in', str(private/'server.csr'), '-CA', str(certs/'ca.crt'), '-CAkey', str(private/'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', str(private/'extensions'), '-out', str(certs/'server.crt'))
    run('podman', 'unshare', 'chown', '0:70', str(certs/'server.key'))
    (certs/'server.key').chmod(0o640)
    (certs/'pg_hba.conf').write_text('local all all trust\nhostnossl all all all reject\nhostssl all all all scram-sha-256\n')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    command = ['podman', 'run', '-d', '--name', NAME, '-p', f'127.0.0.1:{port}:5432', '-v', f'{certs}:/tls:ro', '-v', f'{ROOT}/infra/compose/postgres-init.sh:/docker-entrypoint-initdb.d/init.sh:ro',
        '-e', 'POSTGRES_USER=dd', '-e', 'POSTGRES_PASSWORD=disposable_admin', '-e', 'API_GO_PASSWORD=disposable_go', '-e', 'API_TS_APP_PASSWORD=disposable_app', '-e', 'API_TS_WORKER_PASSWORD=disposable_worker',
        'docker.io/library/postgres:16-alpine', '-c', 'ssl=on', '-c', 'ssl_cert_file=/tls/server.crt', '-c', 'ssl_key_file=/tls/server.key', '-c', 'hba_file=/tls/pg_hba.conf']
    run(*command)
    checks = []
    success = False
    try:
        for _ in range(100):
            ready = subprocess.run(['podman', 'exec', NAME, 'pg_isready', '-U', 'dd'], capture_output=True)
            if ready.returncode == 0:
                # The entrypoint may first start a temporary server before init.
                exists = subprocess.run(['podman', 'exec', NAME, 'psql', '-U', 'dd', '-d', 'postgres', '-Atc', "SELECT count(*) FROM pg_database WHERE datname='api_go'"], capture_output=True, text=True)
                if exists.returncode == 0 and exists.stdout.strip() == '1': break
            time.sleep(.1)
        else: raise RuntimeError('TLS fixture did not become ready')
        for name, host, ca, mode, ok in [('verified TLS', 'localhost', 'ca', 'verify-full', True), ('wrong host', '127.0.0.1', 'ca', 'verify-full', False), ('wrong CA', 'localhost', 'wrong-ca', 'verify-full', False), ('plaintext rejected', 'localhost', 'ca', 'disable', False)]:
            connection = f'host={host} port=5432 user=dd dbname=postgres sslmode={mode} sslrootcert=/tls/{ca}.crt connect_timeout=2'
            result = subprocess.run(['podman', 'exec', '-e', 'PGPASSWORD=disposable_admin', NAME, 'psql', connection, '-Atc', 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'], capture_output=True, text=True)
            assert (result.returncode == 0) == ok, f'{name} unexpected result'
            if ok: assert result.stdout.strip() == 't'
            checks.append({'case': name, 'passed': True})
        fixture = {'container': NAME, 'port': port, 'privateDirectory': str(private), 'caFile': str(certs/'ca.crt'), 'checks': checks}
        (private/'fixture.json').write_text(json.dumps(fixture, indent=2)+'\n')
        (ROOT/'testing/production-readiness/database-tls-results.json').write_text(json.dumps({'checks': checks, 'passed': len(checks), 'scope': 'disposable TLS-only PostgreSQL, not production'}, indent=2)+'\n')
        Path('/tmp/dd-readiness-db-fixture-path').write_text(str(private/'fixture.json'))
        success = True
        print(f'{len(checks)} PostgreSQL TLS controls passed; fixture metadata: {private}/fixture.json')
    finally:
        if not args.keep or not success:
            subprocess.run(['podman', 'rm', '-f', NAME], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__': main()
