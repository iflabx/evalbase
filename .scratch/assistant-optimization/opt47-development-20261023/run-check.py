import os,json,subprocess,pathlib,sys,urllib.parse
root=pathlib.Path(__file__).resolve().parents[3]
def inspect(name):
 d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 assert d['Config']['Labels']['com.docker.compose.project']=='evalbase-agent-test'
 return dict(e.split('=',1) for e in d['Config']['Env']),next(v['IPAddress'] for v in d['NetworkSettings']['Networks'].values() if v['IPAddress'])
p,db=inspect('evalbase-agent-test-postgres-1');m,mi=inspect('evalbase-agent-test-minio-1')
env=dict(os.environ,PATH='/home/bistu/.local/bin:'+os.environ['PATH'])
env.update(DATABASE_URL='postgresql://'+urllib.parse.quote(p['POSTGRES_USER'],safe='')+':'+urllib.parse.quote(p['POSTGRES_PASSWORD'],safe='')+'@'+db+':5432/'+p['POSTGRES_DB'],MINIO_ENDPOINT=mi,MINIO_PORT='9000',MINIO_ACCESS_KEY=m['MINIO_ROOT_USER'],MINIO_SECRET_KEY=m['MINIO_ROOT_PASSWORD'],MINIO_BUCKET='opt47-contract-regressions-20261023',WORKER_HEALTH_PORT='0')
log=root/'.scratch/assistant-optimization/opt47-development-20261023'/sys.argv[1]
with log.open('w') as f:
 r=subprocess.run(sys.argv[2:],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
print(json.dumps({'exitCode':r.returncode,'log':str(log),'databaseServer':'evalbase-agent-test','bucket':env['MINIO_BUCKET']}))
print(log.read_text()[-14000:])
sys.exit(r.returncode)
