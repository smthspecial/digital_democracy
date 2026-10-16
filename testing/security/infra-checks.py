#!/usr/bin/env python3
"""Inspect rendered manifests and exercise only a disposable local NATS server."""
import json, os, socket, subprocess, tempfile, time
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[2]
checks=[]
def check(name,condition):
 checks.append({'case':name,'passed':bool(condition)})
 if not condition:raise AssertionError(name)
compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())
for name,service in compose['services'].items():
 for port in service.get('ports',[]):check(name+' binds loopback',port.startswith('127.0.0.1:'))
check('restricted Go runtime', 'api_go_worker:' in compose['services']['api-go']['environment']['DATABASE_URL'])
check('migration credentials absent from runtime','MIGRATE_DATABASE_URL' not in compose['services']['api-go']['environment'])
check('broker credentials required',':?' in compose['services']['nats']['environment']['NATS_API_GO_PASSWORD'])
for name in ['api-go','api-ts']:
 rendered=subprocess.check_output(['/tmp/dd-security-tools/helm','template',name,str(ROOT/'infra/helm/service'),'-f',str(ROOT/'infra/helm/apps'/f'{name}.yaml')],text=True)
 docs=list(yaml.safe_load_all(rendered));policy=next(d for d in docs if d and d['kind']=='NetworkPolicy')
 check(name+' ingress selects caller namespace and pod', all('matchLabels' in peer['namespaceSelector'] and 'matchLabels' in peer['podSelector'] for rule in policy['spec']['ingress'] for peer in rule['from']))
 check(name+' strict workload TLS',any(d and d['kind']=='PeerAuthentication' and d['spec']['mtls']['mode']=='STRICT' for d in docs))
 check(name+' explicit workload principals',any(d and d['kind']=='AuthorizationPolicy' and d['spec']['rules'] for d in docs))
 check(name+' HTTPS listener reference',any(d and d['kind']=='HTTPRoute' and d['spec']['parentRefs'][0]['sectionName']=='https' for d in docs))
 deployment=next(d for d in docs if d and d['kind']=='Deployment')
 pod=deployment['spec']['template']
 check(name+' injected workload identity',pod['metadata']['labels'].get('sidecar.istio.io/inject')=='true')
 check(name+' non-root runtime',pod['spec']['securityContext']['runAsNonRoot'] and pod['spec']['securityContext']['runAsUser']==10001)
 authz=next(d for d in docs if d and d['kind']=='AuthorizationPolicy')
 internal=[r for r in authz['spec']['rules'] if 'when' in r]
 check(name+' producer bound to workload principal',bool(internal) and all(r['when'][0]['key']=='request.headers[x-dd-service]' and r['from'][0]['source']['principals'][0].endswith('/sa/'+r['when'][0]['values'][0]) for r in internal))
 public=[r for r in authz['spec']['rules'] if 'when' not in r]
 forbidden=['/audit/log','/voting/sessions','/auth/identities/provision','/identity/duplicates/scan']
 import fnmatch
 check(name+' gateway cannot call internal mutations',all('GET' in r['to'][0]['operation']['methods'] or not any(fnmatch.fnmatch(path,pattern) for path in forbidden for pattern in r['to'][0]['operation'].get('paths',[])) for r in public))
 if name=='api-ts':
  excluded={'/identity/duplicates/scan','/identity/registrations/burst-check','/jurisdiction/proposals/{*}/jurisdictions/{*}/eligible-citizens','/governance-role/actions/{*}/protocol-approvals'}
  check('api-ts gateway excludes signed worker reads',all(excluded.issubset(set(r['to'][0]['operation'].get('notPaths',[]))) for r in public if 'GET' in r['to'][0]['operation']['methods']))
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
config=(ROOT/'infra/compose/nats.conf').read_text().replace('port: 4222',f'port: {port}').replace('http_port: 8222','http_port: -1')
with tempfile.TemporaryDirectory(prefix='dd-nats-security-') as directory:
 path=Path(directory)/'nats.conf';path.write_text(config.replace('store_dir: /data/jetstream',f'store_dir: "{directory}/js"')+'\nhost: 127.0.0.1\n')
 # Use the existing repository test tool, never a deployed broker.
 with open('/tmp/dd-security-nats.log','w') as log:
  process=subprocess.Popen([str(Path.home()/'go/bin/nats-server'),'-c',str(path)],env={**os.environ,'NATS_API_GO_PASSWORD':'fixture-only-password'},stdout=log,stderr=subprocess.STDOUT)
  try:
   for _ in range(100):
    try:s=socket.create_connection(('127.0.0.1',port),timeout=.2);s.close();break
    except OSError:time.sleep(.05)
   def request(options,command=''):
    with socket.create_connection(('127.0.0.1',port),timeout=2) as s:
     s.recv(8192);s.sendall(('CONNECT '+json.dumps(options)+'\r\n'+command+'PING\r\n').encode());response=b''
     while b'PONG' not in response and b'-ERR' not in response:response+=s.recv(8192)
     return response
   check('NATS rejects anonymous connections',b'-ERR' in request({'verbose':False}))
   check('NATS accepts application credentials',b'PONG' in request({'verbose':False,'user':'api-go','pass':'fixture-only-password'}))
   check('NATS denies unrelated publish subject',b'Permissions Violation' in request({'verbose':False,'user':'api-go','pass':'fixture-only-password'},'PUB forbidden.subject 1\r\nx\r\n'))
  finally:process.terminate();process.wait(timeout=5)
(ROOT/'testing/production-readiness/infra-validation.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'liveClusterTested':False},indent=2)+'\n')
print(f'{len(checks)} infrastructure checks passed')
