#!/usr/bin/env python3
"""Persistent, loopback-only development stack with explicit migration jobs."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / '.env.local'
RUNTIMES = ['api-go', 'api-ts', 'web']


def initialize():
    if ENV_FILE.exists():
        if ENV_FILE.stat().st_mode & 0o077:
            raise ValueError('Make .env.local private with chmod 600 before continuing')
        return
    lines = []
    for line in (ROOT / '.env.example').read_text().splitlines():
        if line and not line.startswith('#') and line.endswith('='):
            key = line[:-1]
            if key != 'BALLOT_VERIFIER_URL':
                line += secrets.token_hex(32)
        lines.append(line)
    lines.extend(['POSTGRES_PORT=15432', 'NATS_PORT=14222', 'NATS_MONITOR_PORT=18222',
                  'API_GO_PORT=5000', 'API_TS_PORT=4000', 'WEB_PORT=3001',
                  'PROMETHEUS_PORT=19090', 'GRAFANA_PORT=13001'])
    fd = os.open(ENV_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(lines) + '\n')
    print('Created private .env.local; keep it for this stack’s database and audit keys', flush=True)


def wait_http(port, path):
    url = f'http://127.0.0.1:{port}{path}'
    # Local readiness should not go through a configured HTTP proxy.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(90):
        try:
            with client.open(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    raise RuntimeError(f'Local readiness failed: {url}; inspect local.py logs')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['up', 'down', 'status', 'logs'])
    parser.add_argument('--engine', choices=['podman', 'docker'],
                        default='podman' if shutil.which('podman') else 'docker')
    args = parser.parse_args()
    os.chdir(ROOT)
    initialize()
    compose = [args.engine, 'compose', '--project-name', 'dd-local',
               '--env-file', str(ENV_FILE), '--file', 'docker-compose.yml']

    def run(*command):
        subprocess.run(compose + list(command), check=True)

    run('config', '--quiet')  # Never print interpolated credentials.
    if args.command != 'up':
        run(*{'down': ['down'], 'status': ['ps'], 'logs': ['logs', '--tail', '100', *RUNTIMES]}[args.command])
        return
    run('build', 'api-go', 'api-ts', 'api-ts-migrate', 'web')
    # A repeat invocation preserves data and keys while quiescing local writers.
    run('stop', *RUNTIMES)
    run('up', '--detach', '--wait', '--wait-timeout', '90', 'postgres', 'nats')
    run('run', '--rm', '--no-deps', 'api-go-migrate')
    run('run', '--rm', '--no-deps', 'api-ts-migrate')
    run('up', '--detach', '--no-build', '--no-deps', *RUNTIMES)
    settings = dict(line.split('=', 1) for line in ENV_FILE.read_text().splitlines()
                    if line and not line.startswith('#') and '=' in line)
    for key, default, path in [('API_GO_PORT', '5000', '/readyz'),
                               ('API_TS_PORT', '4000', '/readyz'), ('WEB_PORT', '3001', '/')]:
        port = int(os.environ.get(key, settings.get(key, default)))
        wait_http(port, path)
        print(f'Ready: http://localhost:{port}{path}', flush=True)
    print('Local development only; no ballot verifier is configured', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
