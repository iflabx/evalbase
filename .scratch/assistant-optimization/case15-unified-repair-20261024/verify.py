from pathlib import Path
import subprocess,sys,json
r=Path.cwd();d=r/'.scratch/assistant-optimization/case15-unified-repair-20261024';mode=sys.argv[1];label=sys.argv[2] if len(sys.argv)>2 else mode
base=['docker','run','--rm','--name','evalbase-case15-'+label,'--cpus=1.5','--memory=3g','-v',str(r)+':/app','-w','/app']
if mode=='integration':
 base+=['--network','evalbase-agent-test']
 for v in ['NODE_ENV=test','DATABASE_URL=postgresql://agent_test:synthetic-agent-test@evalbase-agent-test-postgres-1:5432/agent_test','MINIO_ENDPOINT=evalbase-agent-test-minio-1','MINIO_PORT=9000','MINIO_ACCESS_KEY=agent-test','MINIO_SECRET_KEY=synthetic-agent-test','MINIO_BUCKET=agent-test','APP_ORIGIN=http://127.0.0.1:4217']:base+=['-e',v]
base+=['evalbase-agent-checkpoint:580bbf41ee39']
if mode=='integration': commands=[['node','node_modules/vitest/vitest.mjs','run','tests/integration/assistant-intent.test.ts','-t',sys.argv[3] if len(sys.argv)>3 else 'B3v8','--exclude','**/.scratch/**','--reporter=dot']]
elif mode=='unit': commands=[['node','node_modules/vitest/vitest.mjs','run',*['tests/unit/'+n+'.test.ts' for n in ['assistant-planning-state','assistant-tool-repair-runtime','assistant-tool-repair','assistant-delivery-plan','assistant-plan-preparation','assistant-recovery-decision','assistant-context']],'--exclude','**/.scratch/**','--reporter=dot']]
else:
 files=subprocess.check_output(['git','diff','--name-only','--','src','tests'],text=True).splitlines()
 commands=[['node','node_modules/prettier/bin/prettier.cjs','--write',*files],['node','node_modules/typescript/bin/tsc','--noEmit'],['node','node_modules/eslint/bin/eslint.js',*files]]
results=[]
for command in commands:
 result=subprocess.run(base+command);results.append({'command':command[:3],'exit':result.returncode})
 if result.returncode:break
(d/(label+'.json')).write_text(json.dumps(results));sys.exit(results[-1]['exit'])
