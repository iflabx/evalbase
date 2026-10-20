import json, os, re, subprocess, sys, time, urllib.request
from pathlib import Path

root = Path.cwd().resolve()
assert str(root) == '/home/bistu/EvalBase/.worktrees/agent-data-processing'
def run(args):
    return subprocess.check_output(args, text=True).strip()
assert run(['git','branch','--show-current']) == 'codex/assistant-optimization'
sha = sys.argv[1]
assert re.fullmatch(r'[0-9a-f]{40}',sha)
subprocess.run(['git','merge-base','--is-ancestor',sha,'HEAD'],check=True)
assert run(['git','status','--porcelain','--untracked-files=no']) == '', 'tracked worktree not clean'
image = 'evalbase-agent-checkpoint:' + sha[:12]
image_info = json.loads(run(['docker','image','inspect',image]))[0]
assert image_info['Config']['Labels']['org.opencontainers.image.revision'] == sha
envfile = root/'.scratch/agent-data-processing/checkpoint.env'
compose = ['docker','compose','--project-name','evalbase-agent-owner-checkpoint','--env-file',str(envfile),'-f',str(root/'.scratch/agent-data-processing/compose.checkpoint.yaml')]
before = json.loads(run(compose+['config','--format','json']))
assert any(str(p.get('published')) == '4217' and p.get('host_ip') == '127.0.0.1' for p in before['services']['web']['ports'])
changed = ['web','model-worker']
kept = ['postgres','minio','worker']
def inspect(service):
    return json.loads(run(['docker','inspect',f'evalbase-agent-owner-checkpoint-{service}-1']))[0]
old_containers = {s:inspect(s) for s in changed+kept}
def sql(query):
    return run(['docker','exec','evalbase-agent-owner-checkpoint-postgres-1','psql','-U','agent_owner','-d','agent_owner','-Atc',query])
assert sql("SELECT count(*) FROM assistant_turn WHERE status IN ('queued','running')") == '0', 'active assistant turn; wait'
assert sql("SELECT count(*) FROM job WHERE status IN ('queued','running','retry_wait')") == '0', 'active jobs; wait'
tables = ['app_user','project','data_asset','source_record','collaborative_draft','collaborative_draft_record','test_set_version','processing_task','processing_run','processing_batch','processing_acceptance','assistant_session','assistant_turn','assistant_proposal','assistant_background_document']
def counts():
    return sql(' UNION ALL '.join("SELECT '"+t+"',count(*) FROM "+t for t in tables))
data_before=counts()
def history_fingerprints():
    return {t:sql("SELECT md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY md5(to_jsonb(r)::text)),'')) FROM "+t+" r") for t in tables}
history_before=history_fingerprints()
def fingerprint():
    return sql("SELECT md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY r.id),'')) FROM collaborative_draft_record r")
fingerprint_before=fingerprint()
backup_db=root/('.scratch/assistant-optimization/opt39-41-checkpoint/owner-before-'+sha[:12]+'.dump')
with backup_db.open('wb') as stream:
    subprocess.run(['docker','exec','evalbase-agent-owner-checkpoint-postgres-1','pg_dump','-U','agent_owner','-d','agent_owner','-Fc'],stdout=stream,check=True)
os.chmod(backup_db,0o600)
old=envfile.read_text()
backup=envfile.with_name('checkpoint.env.pre-opt39-41-'+sha[:12])
backup.write_text(old);os.chmod(backup,0o600)
updated=re.sub(r'^GIT_SHA=.*$','GIT_SHA='+sha,old,count=1,flags=re.M)
updated=re.sub(r'^CHECKPOINT_IMAGE=.*$','CHECKPOINT_IMAGE='+image,updated,count=1,flags=re.M)
assert len(old.splitlines()) == len(updated.splitlines())
assert all(a==b or a.startswith(('GIT_SHA=','CHECKPOINT_IMAGE=')) for a,b in zip(old.splitlines(),updated.splitlines()))
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
rollback=root/'.scratch/assistant-optimization/opt39-41-checkpoint/rollback-images.json'
rollback.write_text(json.dumps({'services':{s:{'image':old_containers[s]['Config']['Image'],'environment':{'GIT_SHA':next((v.split('=',1)[1] for v in old_containers[s]['Config']['Env'] if v.startswith('GIT_SHA=')),'unknown')}} for s in changed}}));os.chmod(rollback,0o600)
try:
    envfile.write_text(updated);os.chmod(envfile,0o600)
    after=json.loads(run(compose+['config','--format','json']))
    assert before['volumes'] == after['volumes'] and before['networks'] == after['networks']
    for s in ['postgres','minio']: assert before['services'][s] == after['services'][s]
    for s in changed: assert after['services'][s]['image'] == image
    run(compose+['up','-d','--no-deps',*changed])
    ready=None
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:4217/health/ready',timeout=2) as response: ready=json.load(response)
            if ready.get('status') == 'ok' and ready.get('git_sha') == sha: break
        except Exception: pass
        time.sleep(2)
    assert ready and ready.get('status') == 'ok' and ready.get('git_sha') == sha
    with opener.open('http://127.0.0.1:4217/health',timeout=5) as response: assert response.status == 200
    with opener.open('http://127.0.0.1:4217/',timeout=5) as response: html=response.read().decode()
    asset=re.search(r'<script[^>]*src="([^"]+)"',html).group(1)
    assert asset.startswith('/assets/')
    with opener.open('http://127.0.0.1:4217'+asset,timeout=5) as response: assert response.status == 200
    for s in kept: assert inspect(s)['Id'] == old_containers[s]['Id']
    for s in changed:
        actual=inspect(s)
        assert actual['State']['Running'] and actual['Image'] == image_info['Id']
        assert 'GIT_SHA='+sha in actual['Config']['Env']
    assert data_before == counts(), 'business counts changed; inspect before claiming preservation'
    assert fingerprint_before == fingerprint(), 'draft record content changed'
    history_after=history_fingerprints()
    assert history_before==history_after, 'history or budget fingerprint changed'
    assert sql("SELECT count(*) FROM assistant_turn WHERE status IN ('queued','running')")== '0'
    assert sql("SELECT count(*) FROM job WHERE status IN ('queued','running','retry_wait')")== '0'
    result={'code':sha,'image':image,'ready':ready,'updated_services':changed,'unchanged_services':kept,'business_counts_equal':True,'draft_content_unchanged':True,'database_backup':str(backup_db),'counts':data_before.splitlines(),'frontend_asset':asset,'history_fingerprints_before':history_before,'history_fingerprints_after':history_after,'history_and_budgets_equal':True,'services_before':{s:{'id':c['Id'],'image':c['Config']['Image']} for s,c in old_containers.items()}}
    (root/'.scratch/assistant-optimization/opt39-41-checkpoint/checkpoint.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False))
except Exception:
    envfile.write_text(old);os.chmod(envfile,0o600)
    subprocess.run(compose+['-f',str(rollback),'up','-d','--no-deps',*changed],check=False)
    raise
