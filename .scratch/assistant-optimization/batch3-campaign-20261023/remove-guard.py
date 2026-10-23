import subprocess,time,json,urllib.request
from pathlib import Path
r=Path.cwd();assert str(r)=="/home/bistu/EvalBase/.worktrees/agent-data-processing"
args=['docker','compose','--project-name','evalbase-agent-owner-checkpoint','--env-file',str(r/'.scratch/agent-data-processing/checkpoint.env'),'-f',str(r/'.scratch/agent-data-processing/compose.checkpoint.yaml')]
subprocess.run(args+['up','-d','--no-deps','--force-recreate','web','model-worker'],check=True,timeout=90)
o=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(20):
 try:
  d=json.load(o.open('http://127.0.0.1:4217/health/ready',timeout=2))
  if d.get('git_sha')=="6b8b7554301c336fe107d6d79ea4435107b708cd" and d.get('status')=='ok':break
 except Exception:pass
 time.sleep(2)
else:raise RuntimeError('health failed')
print(json.dumps({'code':d['git_sha'],'guard':'removed after closed campaign','budgetReset':False}))
