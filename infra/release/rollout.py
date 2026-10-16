#!/usr/bin/env python3
"""Coordinate a prepared release; cluster-specific qualification hooks are mandatory."""
import argparse
from datetime import datetime, timezone
import json
from hashlib import sha256
import os
from pathlib import Path
import subprocess

from prepare import validate


def verify_bundle(bundle):
    if bundle.stat().st_mode & 0o077:
        raise ValueError('Release bundle must be private (mode 0700)')
    checksums = json.loads((bundle/'checksums.json').read_text())
    required = {'release.json', 'certificates.json', 'maintenance.json', 'migrations.json', 'runtimes.yaml'}
    if not required.issubset(checksums): raise ValueError('Incomplete release checksum manifest')
    for name, digest in checksums.items():
        if Path(name).name != name or sha256((bundle/name).read_bytes()).hexdigest() != digest:
            raise ValueError('Release bundle changed after rendering')


def coordinate(config, bundle, hooks, execute):
    execute([str(hooks/'preflight'), str(bundle)])
    execute(['kubectl', 'apply', '-f', str(bundle/'certificates.json')])
    for app in ('api-go', 'api-ts'):
        execute(['kubectl', '-n', app, 'wait', '--for=condition=Ready', 'certificate/dd-gateway-tls', '--timeout=300s'])
    execute(['kubectl', 'apply', '-f', str(bundle/'maintenance.json')])
    execute([str(hooks/'drain'), str(bundle)])
    execute(['kubectl', 'apply', '-f', str(bundle/'migrations.json')])
    for app in ('api-go', 'api-ts'):
        execute(['kubectl', '-n', app, 'wait', '--for=condition=Complete', f'job/{config["releaseId"]}-{app}-migrate', '--timeout=600s'])
    execute(['kubectl', 'apply', '-f', str(bundle/'runtimes.yaml')])
    for app in ('api-go', 'api-ts'):
        execute(['kubectl', '-n', app, 'rollout', 'status', f'deployment/{app}', '--timeout=300s'])
    execute([str(hooks/'verify'), str(bundle)])
    execute([str(hooks/'revoke'), str(bundle)])
    execute(['kubectl', 'delete', '-f', str(bundle/'migrations.json'), '--wait=true'])
    for app in ('api-go', 'api-ts'):
        execute(['kubectl', '-n', app, 'delete', 'secret', config['migrationSecrets'][app]])
    execute([str(hooks/'resume'), str(bundle)])
    execute(['kubectl', 'delete', '-f', str(bundle/'maintenance.json')])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--hooks', type=Path, required=True)
    args = parser.parse_args()
    bundle, hooks = args.bundle.resolve(), args.hooks.resolve()
    verify_bundle(bundle)
    config = json.loads((bundle/'release.json').read_text())
    validate(config)
    for name in ('preflight', 'drain', 'verify', 'revoke', 'resume'):
        if not (hooks/name).is_file() or not os.access(hooks/name, os.X_OK):
            raise ValueError(f'Missing executable qualification hook: {name}')
    for name in ('certificates.json', 'maintenance.json', 'migrations.json', 'runtimes.yaml'):
        if not (bundle/name).is_file(): raise ValueError(f'Missing bundle artifact: {name}')
    base = ['kubectl', '--kubeconfig', config['kubeconfig'], '--context', config['context']]
    journal = bundle/'rollout-journal.jsonl'

    def execute(command):
        actual = base+command[1:] if command[0] == 'kubectl' else command
        # Hook output may contain operational secrets. Keep it in the private
        # bundle; only exit status and step names enter the public journal/UI.
        with open(bundle/'rollout-private.log', 'a') as log:
            result = subprocess.run(actual, stdout=log, stderr=log)
        entry = {'utc': datetime.now(timezone.utc).isoformat(), 'step': command, 'exitCode': result.returncode}
        with open(journal, 'a') as file: file.write(json.dumps(entry)+'\n')
        if result.returncode: raise RuntimeError('Release step failed; inspect the private log and journal. Traffic remains paused after the maintenance step; no schema rollback was attempted.')
    coordinate(config, bundle, hooks, execute)
    print(f'{config["releaseId"]}: both runtimes qualified; migration credentials revoked; traffic resumed')


if __name__ == '__main__': main()
