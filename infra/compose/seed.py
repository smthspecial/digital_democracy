#!/usr/bin/env python3
"""Create or rebuild the dd-local synthetic development fixture.

seed: start/migrate the stack and insert missing fixture rows.
reset: DELETE dd-local volumes, rebuild/migrate, then seed both databases.
users: print synthetic citizen IDs and scenarios without touching databases.
enroll: issue a short-lived enrollment grant using the private reviewer adapter.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

import local
from seed_data import ROLES, USERS, dataset, fixture_id, seed_sql


def compose(engine, *arguments, **kwargs):
    # The target is intentionally fixed. This cannot address a production
    # database URL or an unrelated Compose project via CLI arguments.
    return subprocess.run([engine, 'compose', '--project-name', 'dd-local',
                           '--env-file', str(local.ENV_FILE), '--file', str(local.ROOT / 'docker-compose.yml'),
                           *arguments], check=True, cwd=local.ROOT, **kwargs)


def load_settings():
    local.initialize()
    return dict(line.split('=', 1) for line in local.ENV_FILE.read_text().splitlines()
                if line and not line.startswith('#') and '=' in line)


def install(engine, reset=False):
    settings = load_settings()
    # Read the fixture and validate its required secret before any reset.
    fixtures = dataset(settings.get('IDENTITY_HASH_SECRET'))
    for name in ('COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES'):
        if os.environ.get(name):
            raise ValueError(f'Unset {name} before using the fixed dd-local fixture')
    compose(engine, 'config', '--quiet')
    if reset:
        print('Deleting dd-local databases, login credentials, broker and monitoring volumes. Keeping .env.local.', flush=True)
        compose(engine, 'down', '--volumes', '--remove-orphans')
    subprocess.run([sys.executable, str(local.ROOT / 'infra/compose/local.py'), 'up', '--engine', engine], check=True, cwd=local.ROOT)
    compose(engine, 'stop', *local.RUNTIMES)
    # Keep writers stopped if either transaction fails. A rerun is safe: all
    # fixture IDs are deterministic and INSERTs never overwrite edited rows.
    for database, tables in fixtures.items():
        compose(engine, 'exec', '-T', 'postgres', 'psql', '-X', '-q', '-U', 'dd', '-d', database,
                '-v', 'ON_ERROR_STOP=1', input=seed_sql(tables), text=True)
    compose(engine, 'up', '--detach', '--no-build', '--no-deps', *local.RUNTIMES)
    for key, default, path in [('API_GO_PORT', '5000', '/readyz'), ('API_TS_PORT', '4000', '/readyz'), ('WEB_PORT', '3001', '/')]:
        local.wait_http(int(settings.get(key, default)), path)
    counts = {db: {table: len(rows) for table, rows in tables.items()} for db, tables in fixtures.items()}
    print(f'Seed installed: {len(USERS)} synthetic users, {sum(counts["api_ts"].values())} TypeScript rows, {sum(counts["api_go"].values())} Go rows.')
    print('List users: python3 infra/compose/seed.py users')
    print('Real ballot cryptography remains unavailable; no fake passkeys, sessions, votes or signed audit history were created.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['seed', 'reset', 'users', 'enroll'])
    parser.add_argument('handle', nargs='?', help='Synthetic handle for enroll, e.g. alice or seed-alice')
    parser.add_argument('--engine', choices=['podman', 'docker'], default='podman' if shutil.which('podman') else 'docker')
    parser.add_argument('--output', type=Path, help='New private file for an enrollment grant')
    args = parser.parse_args()
    if args.command == 'users':
        for handle, status, scenario in USERS:
            print(f'seed-{handle:22} {fixture_id("citizen", handle)}  {status:8} {ROLES.get(handle, scenario)}')
        return
    if args.command == 'enroll':
        handle = (args.handle or '').removeprefix('seed-')
        account = next((u for u in USERS if u[0] == handle), None)
        if not account or account[1] != 'active' or account[2] == 'suspended' or not args.output:
            parser.error('enroll needs an active seed handle and --output for a new private grant file')
        load_settings()
        subprocess.run([sys.executable, str(local.ROOT / 'infra/compose/verify_identity.py'),
                        fixture_id('citizen', handle), '--retry-grant', '--output', str(args.output)], check=True)
        return
    install(args.engine, reset=args.command == 'reset')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
