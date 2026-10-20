import json,subprocess,pathlib,sys
root=pathlib.Path.cwd();assert str(root)=='/home/bistu/EvalBase/.worktrees/agent-data-processing'
base=root/'.scratch/assistant-optimization/opt39-41-checkpoint';prior=json.load(open(base/'checkpoint.json'));sid=sys.argv[1];assert sid.startswith('conversation_') and sid.replace('_','').isalnum()
def sql(q):return subprocess.check_output(['docker','exec','evalbase-agent-owner-checkpoint-postgres-1','psql','-U','agent_owner','-d','agent_owner','-Atc',q],text=True).strip()
newtasks="SELECT id FROM processing_task WHERE assistant_session_id='"+sid+"'"
newruns='SELECT id FROM processing_run WHERE task_id IN ('+newtasks+')'
did=sql("SELECT task->>'createdDraftId' FROM assistant_session WHERE id='"+sid+"'")
filters={
 'assistant_session':"r.id<>'"+sid+"'",
 'assistant_turn':"r.session_id<>'"+sid+"'",
 'assistant_proposal':"r.session_id<>'"+sid+"'",
 'assistant_background_document':"r.session_id<>'"+sid+"'",
 'processing_task':"r.id NOT IN ("+newtasks+")",
 'processing_run':"r.id NOT IN ("+newruns+")",
 'processing_batch':"r.run_id NOT IN ("+newruns+")",
 'processing_acceptance':"r.run_id NOT IN ("+newruns+")",
 'collaborative_draft':"r.id<>'"+did+"'",
 'collaborative_draft_record':"r.draft_id<>'"+did+"'"
}
now={}
for t in prior['history_fingerprints_before']:
 where=' WHERE '+filters[t] if t in filters else ''
 now[t]=sql("SELECT md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY md5(to_jsonb(r)::text)),'')) FROM "+t+" r"+where)
changed=[t for t,v in now.items() if prior['history_fingerprints_before'][t]!=v]
assert not changed,changed
result={'newSession':sid,'newDraft':did,'originalTablesUnchanged':True,'fingerprints':now,'newSessionBudget':json.loads(sql("SELECT coalesce(task->'executionBudget','{}') FROM assistant_session WHERE id='"+sid+"'")),'activeTurns':int(sql("SELECT count(*) FROM assistant_turn WHERE status IN ('queued','running')")),'activeJobs':int(sql("SELECT count(*) FROM job WHERE status IN ('queued','running','retry_wait')"))}
(base/'preservation-after-new-flow.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'originalTablesUnchanged':True,'activeTurns':result['activeTurns'],'activeJobs':result['activeJobs']}))
