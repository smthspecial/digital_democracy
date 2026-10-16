#!/usr/bin/env python3
"""Starts only disposable local APIs. No arbitrary remote target support."""
import argparse, hashlib, hmac, json, os, socket, subprocess, tempfile, time, urllib.request, urllib.error, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SECRET='disposable-security-regression-secret'
def free_port():
 with socket.socket() as s: s.bind(('127.0.0.1',0));return s.getsockname()[1]
def headers(method,path,body,service='api-ts'):
 timestamp=str(int(time.time()));nonce=uuid.uuid4().hex
 message='\n'.join([service,method,path,timestamp,nonce,hashlib.sha256(body).hexdigest()])
 return {'X-DD-Service':service,'X-DD-Timestamp':timestamp,'X-DD-Nonce':nonce,'X-DD-Signature':hmac.new(SECRET.encode(),message.encode(),hashlib.sha256).hexdigest()}
def call(base,method,path,body=None,extra=None):
 raw=json.dumps(body,separators=(',',':')).encode() if body is not None else b''
 request=urllib.request.Request(base+path,data=raw if method!='GET' else None,method=method,headers={'Content-Type':'application/json',**(extra or {})})
 try:
  with urllib.request.urlopen(request,timeout=5) as response:return response.status,json.loads(response.read() or b'{}')
 except urllib.error.HTTPError as error:return error.code,json.loads(error.read() or b'{}')
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--database-url');parser.add_argument('--ts-app-url');parser.add_argument('--ts-worker-url');parser.add_argument('--output',required=True);args=parser.parse_args()
 processes=[];results=[]
 def check(name,status,want):
  results.append({'case':name,'status':status,'expected':want,'passed':status==want})
 def start(command,env,path):
  log=open(path,'w');process=subprocess.Popen(command,cwd=ROOT,env={**os.environ,**env},stdout=log,stderr=subprocess.STDOUT);processes.append((process,log));return process
 def wait(process,base):
  for _ in range(100):
   if process.poll() is not None:raise RuntimeError('Fixture API failed to start; see /tmp/dd-security-regression-*.log')
   try:
    if call(base,'GET','/healthz')[0]==200:return
   except (OSError,ValueError):pass
   time.sleep(.1)
  raise RuntimeError('Fixture API startup timed out')
 try:
  port=free_port();base=f'http://127.0.0.1:{port}'
  env={'PORT':str(port),'LISTEN_HOST':'127.0.0.1','DATABASE_URL':args.database_url or '', 'NATS_URL':'','INTERNAL_SERVICE_SHARED_SECRET':SECRET,'AUDIT_SIGNING_KEY':'disposable-audit-test-seed-32-characters','WEBAUTHN_RP_ID':'localhost','WEBAUTHN_RP_ORIGIN':f'http://localhost:{port}'}
  process=start(['/tmp/dd-security-api-go'],env,'/tmp/dd-security-regression-go.log');wait(process,base)
  for path in ['/voting/sessions','/voting/sessions/'+str(uuid.uuid4())+'/open','/voting/sessions/'+str(uuid.uuid4())+'/tokens','/voting/sessions/'+str(uuid.uuid4())+'/tally','/voting/sessions/'+str(uuid.uuid4())+'/certify','/audit/log','/audit/rights','/audit/reviews','/audit/protocol-changes','/delegation/delegations','/delegation/expire','/auth/identities/provision','/auth/revoke-all']:
   check('anonymous '+path,call(base,'POST',path,{})[0],401)
  check('forged ballot bearer',call(base,'POST','/voting/ballots',{}, {'Authorization':'Bearer forged','X-Citizen-ID':str(uuid.uuid4())})[0],401)
  check('anonymous delegation revoke',call(base,'DELETE','/delegation/delegations/'+str(uuid.uuid4()),extra={'X-Citizen-ID':'forged'})[0],401)
  body={'action_type':'system_update','actor_ref':'fixture','payload':'security-control'};raw=json.dumps(body,separators=(',',':')).encode();signed=headers('POST','/audit/log',raw)
  status,entry=call(base,'POST','/audit/log',body,signed);check('signed audit positive control',status,201)
  check('audit provenance',200 if entry.get('actor_ref')=='api-ts:fixture' else 500,200)
  check('unsigned producer substitution',call(base,'POST','/audit/log',body,{**signed,'X-DD-Service':'api-go'})[0],401)
  check('signed replay',call(base,'POST','/audit/log',body,signed)[0],401)
  forged={'action_type':'vote_certified','actor_ref':'voting-service','payload':'fake'};raw=json.dumps(forged,separators=(',',':')).encode()
  check('signed TS cannot impersonate voting',call(base,'POST','/audit/log',forged,headers('POST','/audit/log',raw))[0],403)
  oversized={'action_type':'system_update','actor_ref':'fixture','payload':'x'*65536};raw=json.dumps(oversized,separators=(',',':')).encode()
  check('signed oversized body',call(base,'POST','/audit/log',oversized,headers('POST','/audit/log',raw))[0],413)
  check('invalid audit page size',call(base,'GET','/audit/log?limit=1000000')[0],400)
  check('chain verifies after rejected attacks',200 if call(base,'GET','/audit/verify')[1].get('valid') else 500,200)
  if args.ts_app_url:
   port=free_port();tsbase=f'http://127.0.0.1:{port}'
   env={'PORT':str(port),'LISTEN_HOST':'127.0.0.1','DATABASE_URL':args.ts_app_url,'WORKER_DATABASE_URL':args.ts_worker_url,'INTERNAL_SERVICE_SHARED_SECRET':SECRET,'IDENTITY_VERIFIER_SHARED_SECRET':SECRET,'IDENTITY_HASH_SECRET':SECRET,'AUTH_SERVICE_URL':base,'AUDIT_SERVICE_URL':base}
   ts=start(['node','apps/api-ts/dist/main.js'],env,'/tmp/dd-security-regression-ts.log');wait(ts,tsbase)
   for path in ['/identity/duplicates/scan','/identity/registrations/burst-check']:
    check('anonymous '+path,call(tsbase,'GET',path)[0],401)
   signed=headers('GET','/identity/duplicates/scan',b'','api-go')
   check('signed worker scan',call(tsbase,'GET','/identity/duplicates/scan',extra=signed)[0],200)
   check('TS signed replay',call(tsbase,'GET','/identity/duplicates/scan',extra=signed)[0],401)
 finally:
  for process,log in reversed(processes):
   process.terminate()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:process.kill();process.wait()
   log.close()
  Path(args.output).write_text(json.dumps({'storage':'postgres' if args.database_url else 'memory','cases':results,'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results)},indent=2)+'\n')
 if any(not r['passed'] for r in results):raise SystemExit('security regression failed')
 print(f'{len(results)} security regressions passed')
if __name__=='__main__':main()
