import pathlib,subprocess,sys,shutil,json,tarfile
root=pathlib.Path.cwd().resolve();assert str(root)=='/home/bistu/EvalBase/.worktrees/agent-data-processing'
sha=sys.argv[1];assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==sha
base='sha256:e13f5559bfb502271e03d34fb645047ba3eb71bcfda5e4b161afcbf31a53d5e2'
info=json.loads(subprocess.check_output(['docker','image','inspect',base],text=True))[0]
assert info['Config']['Labels']['org.opencontainers.image.revision']=='ddb0b64d827a429fd7486528b7c2ac519bca4d15'
assert not subprocess.check_output(['git','diff','--name-only','ddb0b64d827a429fd7486528b7c2ac519bca4d15',sha,'--','package.json','package-lock.json','frontend-v3/package.json','frontend-v3/package-lock.json','Dockerfile'],text=True).strip()
work=root/'.scratch/assistant-optimization/opt39-41-checkpoint';work.mkdir(exist_ok=True)
source=work/('source-'+sha);assert not source.exists();source.mkdir()
archive=work/('source-'+sha+'.tar')
with archive.open('wb') as f:subprocess.run(['git','archive',sha],stdout=f,check=True)
with tarfile.open(archive) as t:t.extractall(source,filter='data')
(source/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
(source/'frontend-v3/node_modules').symlink_to(root/'frontend-v3/node_modules',target_is_directory=True)
subprocess.run(['npm','run','build'],cwd=source,check=True)
context=work/('runtime-'+sha);context.mkdir()
shutil.copytree(source/'dist/server',context/'server');shutil.copytree(source/'dist/web',context/'web')
(context/'Dockerfile').write_text(chr(10).join(['FROM '+base,'COPY server ./dist/server','COPY web ./dist/web','']))
subprocess.run(['docker','build','--pull=false','--label','org.opencontainers.image.revision='+sha,'-t','evalbase-agent-checkpoint:'+sha[:12],str(context)],check=True,timeout=90)
print('Fixed archive build verified',sha,flush=True)
