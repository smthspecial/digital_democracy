import json,socket,subprocess,time,urllib.request,urllib.error
from pathlib import Path
checks=[]
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def status(base,path,method='GET'):
 try:
  with urllib.request.urlopen(urllib.request.Request(base+path,data=b'{}' if method=='POST' else None,method=method,headers={'Content-Type':'application/json'}),timeout=2) as r:return r.status
 except urllib.error.HTTPError as e:return e.code
for app in ['api-go','api-ts','web']:
 image=f'localhost/dd-security-{app}:20261008';name=f'dd-security-smoke-{app}-20261008';p=port()
 env={'PORT':str(p),'LISTEN_HOST':'127.0.0.1','APP_ENV':'development'}
 if app=='api-go':env.update(DATABASE_URL='postgres://api_go_worker:fixture_go@127.0.0.1:55484/api_go',AUDIT_SIGNING_KEY='disposable-audit-test-seed-32-characters',INTERNAL_SERVICE_SHARED_SECRET='fixture-internal-key')
 if app=='api-ts':env.update(DATABASE_URL='postgres://api_ts_app:fixture_ts_app@127.0.0.1:55484/api_ts',WORKER_DATABASE_URL='postgres://api_ts_worker:fixture_ts_worker@127.0.0.1:55484/api_ts',INTERNAL_SERVICE_SHARED_SECRET='fixture-internal-key',IDENTITY_HASH_SECRET='fixture-identity-hash-key')
 command=['podman','run','-d','--name',name,'--network','host']
 for k,v in env.items():command+=['-e',f'{k}={v}']
 command+=[image]
 if app=='web':command+=['node','apps/web/node_modules/next/dist/bin/next','start','apps/web','--hostname','127.0.0.1','--port',str(p)]
 subprocess.run(command,check=True,stdout=subprocess.DEVNULL)
 try:
  base=f'http://127.0.0.1:{p}';path='/' if app=='web' else '/healthz'
  for _ in range(100):
   try:
    if status(base,path)==200:break
   except (OSError,ValueError):pass
   time.sleep(.1)
  else:raise AssertionError(f'{app} failed startup')
  checks.append({'case':app+' container health','passed':True})
  user=subprocess.check_output(['podman','inspect',name,'--format','{{.Config.User}}'],text=True).strip()
  assert user not in ['','0','root'];checks.append({'case':app+' non-root container','passed':True})
  if app!='web':
   denied=status(base,'/voting/sessions' if app=='api-go' else '/identity/duplicates/scan','POST' if app=='api-go' else 'GET')
   assert denied==401;checks.append({'case':app+' denies anonymous internal operation','passed':True})
 finally:
  subprocess.run(['podman','logs',name],stdout=open('/tmp/dd-security-smoke-'+app+'.log','w'),stderr=subprocess.STDOUT)
  subprocess.run(['podman','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
Path('testing/security/container-validation.json').write_text(json.dumps({'builds':['api-go','api-ts','web'],'checks':checks,'passed':len(checks),'imageAdvisoryScan':False},indent=2)+'\n')
print(f'{len(checks)} container smoke checks passed')
