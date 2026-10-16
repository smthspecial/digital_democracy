#!/usr/bin/env python3
"""Render a reviewable release bundle without touching a cluster or reading secrets."""
import argparse
import json
from hashlib import sha256
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
NAME = re.compile(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\Z')
DIGEST_IMAGE = re.compile(r'[^\s@]+@sha256:[0-9a-f]{64}\Z')


def validate(config):
    for key in ('releaseId', 'issuer', 'gatewayNamespace', 'gatewayServiceAccount', 'databaseNamespace', 'databasePodLabel', 'runtimeCASecret', 'brokerIdentitySecret'):
        if not NAME.fullmatch(config.get(key, '')) or len(config[key]) > 40:
            raise ValueError(f'Invalid {key}')
    if not config.get('context') or 'REPLACE' in config['context'] or not Path(config.get('kubeconfig', '')).is_absolute():
        raise ValueError('An explicit context and absolute kubeconfig are required')
    if not re.fullmatch(r'[a-z0-9.-]+\.[a-z]{2,}', config.get('domain', '')):
        raise ValueError('An owned DNS domain is required')
    for app in ('api-go', 'api-ts', 'api-ts-migration'):
        if not DIGEST_IMAGE.fullmatch(config.get('images', {}).get(app, '')):
            raise ValueError(f'{app} requires an immutable registry digest')
    for app in ('api-go', 'api-ts'):
        if not NAME.fullmatch(config.get('migrationSecrets', {}).get(app, '')):
            raise ValueError(f'{app} requires a separate temporary migration secret')
        if config['migrationSecrets'][app] in ('api-go-runtime', 'api-ts-runtime'):
            raise ValueError('Runtime and migration secrets must differ')
    peer = urlparse(config.get('ballotVerifierURL', ''))
    if peer.username or peer.password or not peer.hostname or (peer.scheme != 'https' and (peer.scheme != 'http' or not peer.hostname.endswith('.svc.cluster.local'))):
        raise ValueError('Ballot verifier requires HTTPS or a mesh-local address')


def migration_resources(config, app):
    name = f"{config['releaseId']}-{app}-migrate"
    labels = {'dd.io/migration': app, 'app.kubernetes.io/version': config['releaseId']}
    meta = {'name': name, 'namespace': app, 'labels': labels}
    image = config['images'][app if app == 'api-go' else 'api-ts-migration']
    env = [{'name': 'MIGRATE_DATABASE_URL', 'valueFrom': {'secretKeyRef': {'name': config['migrationSecrets'][app], 'key': 'MIGRATE_DATABASE_URL'}}}]
    env += [{'name': 'APP_ENV', 'value': 'production'}]
    if app == 'api-go':
        env += [{'name': 'MIGRATE_ONLY', 'value': '1'}]
    job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': meta, 'spec': {
        'backoffLimit': 0, 'activeDeadlineSeconds': 600, 'ttlSecondsAfterFinished': 86400,
        'template': {'metadata': {'labels': labels, 'annotations': {'sidecar.istio.io/inject': 'false'}}, 'spec': {
            'restartPolicy': 'Never', 'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 10001, 'runAsGroup': 10001, 'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{'name': 'migrate', 'image': image, 'env': env,
                'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
                'volumeMounts': [{'name': 'database-ca', 'mountPath': '/etc/dd/database', 'readOnly': True}]}],
            'volumes': [{'name': 'database-ca', 'secret': {'secretName': config['runtimeCASecret'], 'defaultMode': 292}}]
        }}
    }}
    policy = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': meta,
        'spec': {'podSelector': {'matchLabels': {'dd.io/migration': app}}, 'policyTypes': ['Ingress', 'Egress'], 'ingress': [], 'egress': [
            {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': config['databaseNamespace']}}, 'podSelector': {'matchLabels': {'app.kubernetes.io/name': config['databasePodLabel']}}}], 'ports': [{'protocol': 'TCP', 'port': 5432}]},
            {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}}, 'podSelector': {'matchLabels': {'k8s-app': 'kube-dns'}}}], 'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]}
        ]}}
    return [policy, job]


def maintenance_resource(config, app):
    return {'apiVersion': 'security.istio.io/v1', 'kind': 'AuthorizationPolicy',
        'metadata': {'name': 'dd-release-maintenance', 'namespace': app},
        'spec': {'selector': {'matchLabels': {'app.kubernetes.io/name': app}}, 'action': 'DENY', 'rules': [{
            'from': [{'source': {'principals': [f"cluster.local/ns/{config['gatewayNamespace']}/sa/{config['gatewayServiceAccount']}"]}}],
            'to': [{'operation': {'methods': ['POST', 'PUT', 'PATCH', 'DELETE']}}]
        }]}}


def certificate_resource(config, app):
    return {'apiVersion': 'cert-manager.io/v1', 'kind': 'Certificate',
        'metadata': {'name': 'dd-gateway-tls', 'namespace': app},
        'spec': {'secretName': 'dd-gateway-tls', 'dnsNames': [config['domain']],
            'issuerRef': {'name': config['issuer'], 'kind': 'ClusterIssuer'},
            'privateKey': {'rotationPolicy': 'Always'}, 'renewBefore': '720h'}}


def gateway_resource(config, app):
    return {'apiVersion': 'gateway.networking.k8s.io/v1', 'kind': 'Gateway',
        'metadata': {'name': 'dd-gateway', 'namespace': app},
        'spec': {'gatewayClassName': 'dd-gateway', 'listeners': [{
            'name': 'https', 'hostname': config['domain'], 'protocol': 'HTTPS', 'port': 443,
            'tls': {'mode': 'Terminate', 'certificateRefs': [{'name': 'dd-gateway-tls'}]},
            'allowedRoutes': {'namespaces': {'from': 'Same'}}
        }]}}


def prepare(config, output, helm):
    validate(config)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    documents = {'migrations': [], 'maintenance': [], 'certificates': []}
    runtimes = []
    for app in ('api-go', 'api-ts'):
        documents['migrations'] += migration_resources(config, app)
        documents['maintenance'].append(maintenance_resource(config, app))
        documents['certificates'].append(certificate_resource(config, app))
        documents['certificates'].append(gateway_resource(config, app))
        repository, digest = config['images'][app].split('@')
        values = {'releaseId': config['releaseId'], 'image': {'repository': repository, 'digest': digest},
            'gatewayNamespace': config['gatewayNamespace'], 'gatewayServiceAccount': config['gatewayServiceAccount'],
            'allowedIngress': [{'namespace': config['gatewayNamespace'], 'name': config['gatewayServiceAccount'], 'publicGateway': True}, {'namespace': 'api-ts' if app == 'api-go' else 'api-go', 'name': 'api-ts' if app == 'api-go' else 'api-go'}],
            'secretVolumes': [{'name': 'database-ca', 'secretName': config['runtimeCASecret'], 'mountPath': '/etc/dd/database'}]}
        values['allowedDependencies'] = [{'namespace': config['databaseNamespace'], 'name': config['databasePodLabel'], 'port': 5432}]
        if app == 'api-go':
            values['allowedDependencies'].append({'namespace': 'infrastructure', 'name': 'nats', 'port': 4222})
            values['allowedIngress'].append({'namespace': 'api-go', 'name': 'api-go'})
            verifier_host = urlparse(config['ballotVerifierURL']).hostname
            if verifier_host.endswith('.svc.cluster.local'):
                values['allowedEgress'] = ['api-ts', 'api-go', verifier_host.split('.')[1]]
            values['secretVolumes'].append({'name': 'broker-tls', 'secretName': config['brokerIdentitySecret'], 'mountPath': '/etc/dd/broker'})
            values['configEnv'] = {'BALLOT_VERIFIER_URL': config['ballotVerifierURL'], 'NATS_TLS_CA_FILE': '/etc/dd/broker/ca.crt', 'NATS_TLS_CERT_FILE': '/etc/dd/broker/tls.crt', 'NATS_TLS_KEY_FILE': '/etc/dd/broker/tls.key', 'WEBAUTHN_RP_ID': config['domain'], 'WEBAUTHN_RP_ORIGIN': 'https://' + config['domain']}
        else:
            values['allowedIngress'].append({'namespace': 'identity-verifier', 'name': 'identity-verifier'})
        overrides = output / f'{app}-values.json'
        overrides.write_text(json.dumps(values, indent=2) + '\n')
        runtimes.append(subprocess.check_output([helm, 'template', app, str(ROOT/'infra/helm/service'), '--namespace', app, '-f', str(ROOT/f'infra/helm/apps/{app}.yaml'), '-f', str(overrides)], text=True))
    for name, items in documents.items():
        (output/f'{name}.json').write_text(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}, indent=2)+'\n')
    (output/'runtimes.yaml').write_text('\n---\n'.join(runtimes))
    (output/'release.json').write_text(json.dumps(config, indent=2)+'\n')
    checksums = {path.name: sha256(path.read_bytes()).hexdigest() for path in sorted(output.iterdir()) if path.is_file()}
    (output/'checksums.json').write_text(json.dumps(checksums, indent=2)+'\n')
    print(f'Rendered {config["releaseId"]}; no cluster was changed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--helm', default='helm')
    args = parser.parse_args()
    prepare(json.loads(args.config.read_text()), args.output, args.helm)
