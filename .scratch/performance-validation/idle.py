import json, pathlib, subprocess, time

root=pathlib.Path('/home/bistu/EvalBase')
evidence=root/'local-acceptance-evidence/performance-validation'
fixture=json.loads((evidence/'fixture.json').read_text())
container='evalbase-performance-validation-postgres-1'
def sql(statement):
    result=subprocess.run(['docker','exec','-e','PGAPPNAME=performance-idle-probe',container,'psql','-U','performance_validation','-d','evalbase_performance_validation','-At','-c',statement],capture_output=True,text=True,timeout=10)
    if result.returncode: raise RuntimeError('database_probe_failed')
    return result.stdout.strip()
def count():
    return int(sql("SELECT xact_commit FROM pg_stat_database WHERE datname=current_database()"))
before=count()
started=time.time()
(evidence/'status.json').write_text(json.dumps({'phase':'idle-baseline','measureSeconds':600,'at':started}))
while time.time()-started<600:
    if (evidence/'STOP.json').exists(): raise RuntimeError('safety_stop')
    time.sleep(5)
after=count()
# Only a previously recorded synthetic version in this dedicated database is enqueued.
version=fixture['samples'][1]['versionId']
project=fixture['project']
assert version.startswith('version_') and project.startswith('project_')
job='performance_idle_checkpoint'
enqueued=time.time()
sql(f"INSERT INTO job(id,project_id,actor_id,kind,payload,status,correlation_id,idempotency_key) SELECT '{job}','{project}',id,'materialize_version_checkpoint','{{\"versionId\":\"{version}\"}}','queued','{job}','{job}' FROM app_user WHERE role='admin'")
observed=None
while time.time()-enqueued<30:
    status=sql(f"SELECT status FROM job WHERE id='{job}'")
    if status!='queued' and observed is None: observed=time.time()-enqueued
    if status in ['succeeded','failed','cancelled']: break
    time.sleep(.1)
assert status=='succeeded',status
(evidence/'idle-result.json').write_text(json.dumps({'seconds':time.time()-started,'transactions':after-before,'monitorQuerySamplingSeconds':30,'healthAndMetricsSamplingSeconds':5,'observedPickupOrCompletionSeconds':observed,'status':status,'queryPrecision':'psql/docker scheduling included'},indent=2))
(evidence/'idle-complete').write_text('passed')
