#!/usr/bin/env python3
"""Check and restart only the dd-local development stack; preserve its volumes."""
import json,subprocess,urllib.request,urllib.error,hashlib,time,datetime
from pathlib import Path
root=Path(__file__).resolve().parents[2]
checks=[]
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def record(name, passed, detail=None):
    checks.append({'name':name,'passed':bool(passed),**({'detail':detail} if detail is not None else {})})
    if not passed: raise RuntimeError('Local check failed: '+name)
def cmd(args, **kwargs): return subprocess.run(args,capture_output=True,text=True,**kwargs)
def sql(db, query):
    r=cmd(['podman','exec','dd-local-postgres-1','psql','-U','dd','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',query],check=True)
    return r.stdout.strip()
def status(port,path,method='GET',data=None):
    try:
        with client.open(urllib.request.Request(f'http://127.0.0.1:{port}{path}',method=method,data=data,headers={'Content-Type':'application/json'}),timeout=3) as r:return r.status
    except urllib.error.HTTPError as e:return e.code
for port,path in [(5000,'/readyz'),(4000,'/readyz'),(3001,'/')]:record('HTTP readiness '+str(port),status(port,path)==200)
for path in ['/identity/duplicates/scan','/identity/registrations/burst-check','/jurisdiction/proposals/00000000-0000-0000-0000-000000000001/jurisdictions/00000000-0000-0000-0000-000000000002/eligible-citizens','/governance-role/actions/00000000-0000-0000-0000-000000000001/protocol-approvals']:
    code=status(4000,path);record('Anonymous worker read denied '+path,code in (401,403),{'status':code})
record('Anonymous Go identity provisioning denied',status(5000,'/auth/identities/provision','POST',b'{}') in (401,403))
record('TypeScript public database read works',status(4000,'/jurisdiction/jurisdictions')==200)
roles=sql('postgres',"SELECT rolname||':'||rolsuper||':'||rolcreatedb||':'||rolcreaterole||':'||rolbypassrls FROM pg_roles WHERE rolname IN ('api_go_worker','api_ts_app','api_ts_worker') ORDER BY rolname")
record('All three database logins are restricted',all(x.endswith(':false:false:false:false') for x in roles.splitlines()) and len(roles.splitlines())==3)
record('Shared RLS policy roles cannot log in',sql('postgres',"SELECT count(*) FROM pg_roles WHERE rolname IN ('api_app','api_worker') AND NOT rolcanlogin")=='2')
for role,password,db,other in [('api_go_worker','API_GO_PASSWORD','api_go','api_ts'),('api_ts_app','API_TS_APP_PASSWORD','api_ts','api_go'),('api_ts_worker','API_TS_WORKER_PASSWORD','api_ts','api_go')]:
    for target,positive in [(db,True),(other,False)]:
        script=f'PGPASSWORD="${password}" psql -h 127.0.0.1 -U {role} -d {target} -At -c "SELECT current_database()"'
        r=cmd(['podman','exec','dd-local-postgres-1','sh','-c',script])
        record(role+(' own database works' if positive else ' cross-database denied'),(r.returncode==0 and r.stdout.strip()==db) if positive else r.returncode!=0)
for name in ['api-go','api-ts','web','postgres','nats']:
    inspection=json.loads(cmd(['podman','inspect','dd-local-'+name+'-1'],check=True).stdout)[0]
    bindings=inspection['HostConfig']['PortBindings']
    record(name+' binds only loopback',bool(bindings) and all(p['HostIp']=='127.0.0.1' for entries in bindings.values() for p in entries))
    if name.startswith('api-'):
        env=dict(x.split('=',1) for x in inspection['Config']['Env'] if '=' in x)
        record(name+' runtime excludes migration URL',not env.get('MIGRATE_DATABASE_URL') and env.get('APP_ENV')=='development')
key_hash=hashlib.sha256((root/'.env.local').read_bytes()).digest()
versions_before=(sql('api_go','SELECT count(*) FROM schema_migrations'),sql('api_ts','SELECT count(*) FROM _prisma_migrations'))
record('Both schemas migrated',all(int(n)>0 for n in versions_before))
probe='dd_local_restart_probe'
record('Disposable restart probe database absent',sql('postgres',f"SELECT count(*) FROM pg_database WHERE datname='{probe}'")=='0')
sql('postgres',f'CREATE DATABASE {probe}')
try:
    sql(probe,"CREATE TABLE marker(value text NOT NULL); INSERT INTO marker VALUES ('synthetic-local-restart-marker')")
    with open('/tmp/dd-local-repeat-check.log','w') as log:
        subprocess.run(['python3','infra/compose/local.py','down'],cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
        subprocess.run(['python3','infra/compose/local.py','up'],cwd=root,stdout=log,stderr=subprocess.STDOUT,check=True)
    record('Database data survives complete local restart',sql(probe,'SELECT value FROM marker')=='synthetic-local-restart-marker')
    record('Migration history preserved',versions_before==(sql('api_go','SELECT count(*) FROM schema_migrations'),sql('api_ts','SELECT count(*) FROM _prisma_migrations')))
    record('Stable local secrets and audit key preserved',key_hash==hashlib.sha256((root/'.env.local').read_bytes()).digest())
finally:
    sql('postgres',f'DROP DATABASE {probe}')
record('Restart probe database removed',sql('postgres',f"SELECT count(*) FROM pg_database WHERE datname='{probe}'")=='0')
for port,path in [(5000,'/readyz'),(4000,'/readyz'),(3001,'/')]:record('Readiness after restart '+str(port),status(port,path)==200)
record('Private local secrets file',((root/'.env.local').stat().st_mode & 0o077)==0)
record('JetStream has a persistent named volume',any(m['Destination']=='/data' and m['Type']=='volume' for m in json.loads(cmd(['podman','inspect','dd-local-nats-1'],check=True).stdout)[0]['Mounts']))
identities=[]
for name in ['api-go','api-ts','api-ts-migration','web']:
    d=json.loads(cmd(['podman','image','inspect','localhost/digital-democracy/'+name+':local'],check=True).stdout)[0]
    identities.append({'name':name,'imageConfigDigest':d['Id']})
report={'recordedDate':datetime.datetime.now(datetime.timezone.utc).date().isoformat(),'scope':'solo local development, synthetic probe only','productionQualified':False,'passed':True,'checks':checks,'checkCount':len(checks),'images':identities,'migrationCounts':{'go':int(versions_before[0]),'prisma':int(versions_before[1])},'failureSequencingUnitTests':2}
(root/'testing/production-readiness/local-development-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(str(len(checks))+' local development checks passed; both runtimes and web remain running')
