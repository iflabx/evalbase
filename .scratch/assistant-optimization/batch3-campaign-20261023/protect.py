import pathlib,json,subprocess,hashlib,collections,sys,os
r=pathlib.Path('/home/bistu/EvalBase/.worktrees/agent-data-processing');d=r/'.scratch/assistant-optimization/batch3-campaign-20261023';mode=sys.argv[1]
def sql(q):return subprocess.check_output(['docker','exec','evalbase-agent-owner-checkpoint-postgres-1','psql','-U','agent_owner','-d','agent_owner','-Atc',q],text=True).strip()
tables=['app_user','project','project_member','data_asset','source_record','collaborative_draft','collaborative_draft_record','test_set_version','processing_task','processing_run','processing_batch','processing_acceptance','assistant_session','assistant_turn','assistant_proposal','assistant_background_document','model_connection','job']
def columns():
 return {t:sql("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='"+t+"' ORDER BY ordinal_position").splitlines() for t in tables}
def fingerprints(cols):
 return {t:dict(collections.Counter(sql('SELECT md5(row_to_json(r)::text) FROM (SELECT '+','.join('"'+c+'"' for c in cols[t])+' FROM "'+t+'") r').splitlines())) for t in tables}
def budgets():
 p=r/'.scratch/assistant-optimization';files=list(p.glob('*budget*.json'))
 for c in p.iterdir():
  if c.is_dir() and c.name != d.name:files.extend(c.glob('*budget*.json'))
 files.extend([r/".scratch/assistant-optimization/opt50-case10-adoption-repair-20261023/campaign/budget.json",r/".scratch/assistant-optimization/opt50-case10-clean-contract-20261023/campaign/budget.json",r/'.scratch/assistant-optimization/opt50-case10-discovery-routing-20261023/campaign/budget.json',r/'.scratch/assistant-optimization/opt50-case10-scope-repair-20261023/campaign/budget.json',r/".scratch/assistant-optimization/opt50-case10-schema-repair-20261023/campaign/budget.json",r/".scratch/assistant-optimization/opt50-case10-root-repair-20261023/campaign/budget.json",r/".scratch/assistant-optimization/opt50-development-20261023/campaign/budget.json",r/".scratch/assistant-optimization/opt50-case10-repair-20261023/campaign/budget.json"])
 files.append(r/".scratch/assistant-optimization/opt50-case7-retest-20261023/campaign/budget.json")
 files.append(r/".scratch/assistant-optimization/opt50-case7-content-repair-20261023/campaign/budget.json")
 return {str(f.relative_to(r)):hashlib.sha256(f.read_bytes()).hexdigest() for f in files if f.is_file()}
if mode=='before':
 assert sql("SELECT count(*) FROM assistant_turn WHERE status IN ('queued','running')")=='0'
 assert sql("SELECT count(*) FROM job WHERE status IN ('queued','running','retry_wait')")=='0'
 cols=columns();data={'columns':cols,'tables':fingerprints(cols),'budgets':budgets()};(d/'protection-before.json').write_text(json.dumps(data));os.chmod(d/'protection-before.json',0o600)
 with (d/'owner-before.dump').open('xb') as out:subprocess.run(['docker','exec','evalbase-agent-owner-checkpoint-postgres-1','pg_dump','-U','agent_owner','-d','agent_owner','-Fc'],stdout=out,check=True)
 os.chmod(d/'owner-before.dump',0o600)
 legacy=r/'.scratch/assistant-optimization/batch1-repair/semantic-results.json'
 if legacy.exists():(d/'legacy-live-current.json').write_bytes(legacy.read_bytes())
 (d/'legacy-committed.json').write_bytes(subprocess.check_output(['git','show','HEAD:.scratch/assistant-optimization/batch1-repair/semantic-results.json'],cwd=r))
 print(json.dumps({'protectedTables':len(tables),'oldBudgetFiles':len(data['budgets']),'backup':'owner-before.dump'}))
else:
 before=json.loads((d/'protection-before.json').read_text());after={'tables':fingerprints(before['columns']),'budgets':budgets()}
 assert all(after['budgets'].get(k)==v for k,v in before['budgets'].items()),'old budget files changed'
 for t,rows in before['tables'].items():
  old=collections.Counter(rows);new=collections.Counter(after['tables'][t]);assert not(old-new),(t,'old rows changed or removed')
  if mode=='after-deploy':assert old==new,(t,'unexpected deployment data change')
 (d/('protection-'+mode+'.json')).write_text(json.dumps(after));os.chmod(d/('protection-'+mode+'.json'),0o600)
 print(json.dumps({'protectedTables':len(tables),'oldBudgetFiles':len(before['budgets']),'oldRowsPreserved':True,'mode':mode}))
