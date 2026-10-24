from pathlib import Path
import json,subprocess,collections
r=Path.cwd();d=r/'.scratch/assistant-optimization/case15-unified-repair-20261024';s=json.loads((d/'campaign/budget.json').read_text());pid=s['projectId'];sid=s['sessions']['15'];assert pid.startswith('project_') and sid.startswith('conversation_')
def sql(q):return subprocess.check_output(['docker','exec','evalbase-agent-owner-checkpoint-postgres-1','psql','-U','agent_owner','-d','agent_owner','-Atc',q],text=True).strip()
def value(q):return json.loads(sql(q))
e=json.loads((d/'case15-final-evidence.json').read_text());task=e['session']['task'];assert task['stage']=='complete';assert all(t['status']=='succeeded' and not t['error_code'] for t in e['turns']);assert not [x for t in e['turns'] for x in t['tool_results'] if x.get('status')=='failed']
drafts=value("SELECT coalesce(json_agg(t),'[]') FROM (SELECT d.id,d.name,d.status,d.published_version_id,count(r.id) FILTER(WHERE NOT r.deleted) AS records,count(DISTINCT r.id) FILTER(WHERE NOT r.deleted) AS distinct_records FROM collaborative_draft d LEFT JOIN collaborative_draft_record r ON r.draft_id=d.id WHERE d.project_id='"+pid+"' GROUP BY d.id,d.name,d.status,d.published_version_id ORDER BY d.name) t")
assert len(drafts)==2 and all(x['records']==2 and x['distinct_records']==2 and x['published_version_id'] is None for x in drafts)
assert set(x['name'] for x in drafts)=={'查物流测试集','改地址测试集'}
acceptances=value("SELECT coalesce(json_agg(t),'[]') FROM (SELECT id,run_id,draft_id,jsonb_array_length(result_ids) AS adopted FROM processing_acceptance WHERE project_id='"+pid+"' ORDER BY created_at) t")
assert len(acceptances)==2 and all(x['adopted']==2 for x in acceptances)
counts={t:int(sql("SELECT count(*) FROM "+t+" WHERE project_id='"+pid+"'")) for t in ['assistant_session','processing_run','data_asset','test_set']}
assert {k:counts[k] for k in ['assistant_session','processing_run','test_set']}=={'assistant_session':1,'processing_run':2,'test_set':0}
assert sql("SELECT count(*) FROM processing_run WHERE project_id='"+pid+"' AND source->>'kind'='background'")== '2'
assert int(sql("SELECT count(*) FROM test_set_version v JOIN test_set s ON s.id=v.test_set_id WHERE s.project_id='"+pid+"'"))==0
labels=value("SELECT coalesce(json_agg(t),'[]') FROM (SELECT d.name,m->>'value' AS label,count(*) AS records FROM collaborative_draft d JOIN collaborative_draft_record r ON r.draft_id=d.id CROSS JOIN LATERAL jsonb_array_elements(r.metadata) m WHERE d.project_id='"+pid+"' AND NOT r.deleted AND m->>'key'='意图' GROUP BY d.name,m->>'value' ORDER BY d.name) t")
assert len(labels)==2 and all(x['records']==2 and x['name']==x['label']+'测试集' for x in labels)
assert sum(c.get('generationCount',0) for c in s['calls'])==4 and sum(c.get('processingCount',0) for c in s['calls'])==0
assert not s['blocked'] and all(c['durationMs'] is not None and c['httpStatus']==200 for c in s['calls'])
repairs=sum(v['used'] for v in task.get('parameterRepairLimits',{}).values());assert repairs==0
summary={'code':s['code'],'projectId':pid,'sessionId':sid,'stage':task['stage'],'steps':len(task['executionPlan']['steps']),'allStepsExecuted':all(x['status']=='executed' for x in task['executionPlan']['steps']),'drafts':drafts,'acceptances':acceptances,'labels':labels,'counts':counts,'requests':len(s['calls']),'requestDurationMsSum':sum(c['durationMs'] for c in s['calls']),'repairs':repairs,'toolErrors':0,'generated':4,'published':0,'queryWordingObservation':'暂停查询正确报告首份2条和第二份未生成，但称确认卡待确认；实际旧卡已失效，继续后正确重建。'}
(d/'delivery-audit.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary,ensure_ascii=False))
