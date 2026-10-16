"""Encrypted backup/restore drill for this task's disposable PostgreSQL only.

Production backup custody, old audit provenance and regional recovery require
target-specific work. This does not read or back up any existing user database.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    fixture = json.loads(Path(Path('/tmp/dd-readiness-db-fixture-path').read_text()).read_text())
    assert fixture['container'] == 'dd-readiness-postgres-20261008'
    private = Path(fixture['privateDirectory'])/'backup-drill'
    private.mkdir(mode=0o700)
    home = private/'gnupg'
    home.mkdir(mode=0o700)
    password = private/'passphrase'
    password.write_text(os.urandom(32).hex())
    password.chmod(0o600)
    gpg = ['gpg', '--homedir', str(home), '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-file', str(password)]
    checks = []

    def run(command, data=None):
        result = subprocess.run(command, input=data, capture_output=True)
        if result.returncode:
            (private/'error.log').write_bytes(result.stderr)
            raise RuntimeError('Disposable backup drill command failed; inspect its private error log')
        return result.stdout

    def pg(tool, database, *arguments, data=None):
        url = f'postgres://dd:disposable_admin@localhost:5432/{database}?sslmode=verify-full&sslrootcert=/tls/ca.crt'
        return run(['podman', 'exec', '-i', fixture['container'], tool, '--dbname='+url, *arguments], data)

    def snapshot(database):
        names = pg('psql', database, '-Atc', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").decode().splitlines()
        tables = {}
        for name in names:
            quoted = '"'+name.replace('"', '""')+'"'
            rows = pg('psql', database, '-Atc', f'SELECT to_jsonb(t)::text FROM public.{quoted} t ORDER BY to_jsonb(t)::text')
            tables[name] = {'rows': len(rows.splitlines()), 'sha256': hashlib.sha256(rows).hexdigest()}
        return tables

    try:
        for database in ('api_go', 'api_ts'):
            before = snapshot(database)
            dump = pg('pg_dump', database, '--format=custom')
            encrypted = private/f'{database}.pgdump.gpg'
            run(gpg+['--symmetric', '--cipher-algo', 'AES256', '--output', str(encrypted)], dump)
            encrypted.chmod(0o600)
            restored_dump = run(gpg+['--decrypt', str(encrypted)])
            assert restored_dump == dump
            checks.append({'case': f'{database} encrypted archive decrypts exactly', 'passed': True})
            # Decryption must succeed before anything reaches pg_restore. GPG's
            # integrity check can fail after producing partial plaintext output.
            bad = bytearray(encrypted.read_bytes())
            bad[-8] ^= 1
            tampered = private/f'{database}.tampered.gpg'
            tampered.write_bytes(bad)
            rejected = subprocess.run(gpg+['--decrypt', str(tampered)], capture_output=True)
            assert rejected.returncode != 0
            checks.append({'case': f'{database} corrupted encrypted archive rejected before restore', 'passed': True})
            target = database+'_dd_restore_fixture'
            created = False
            try:
                pg('psql', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', f'CREATE DATABASE {target}')
                created = True
                pg('psql', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', f'REVOKE CONNECT ON DATABASE {target} FROM PUBLIC')
                pg('pg_restore', target, '--exit-on-error', data=restored_dump)
                after = snapshot(target)
                assert after == before, f'{database} restored data mismatch'
                checks.append({'case': f'{database} all public tables restore with matching row counts and data digests', 'passed': True, 'tables': len(before), 'rows': sum(t['rows'] for t in before.values())})
            finally:
                if created: pg('psql', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', f'DROP DATABASE {target}')
        result = {'checks': checks, 'passed': len(checks), 'scope': 'fresh disposable databases only, TLS-verified dump/restore and GPG AES256 integrity-protected archives', 'productionQualified': False, 'limitations': ['Synthetic backup passphrase and archives co-located temporarily; no production/offsite custody qualification', 'Table preservation is not independent provenance verification of historical audit signatures', 'No regional outage, restore-time or national-scale recovery claim']}
        (ROOT/'testing/production-readiness/backup-restore-results.json').write_text(json.dumps(result, indent=2)+'\n')
        print(f'{len(checks)} disposable encrypted backup/restore checks passed')
    finally:
        subprocess.run(['gpgconf', '--homedir', str(home), '--kill', 'gpg-agent'], capture_output=True)


if __name__ == '__main__': main()
