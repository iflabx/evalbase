import json, os, pathlib, subprocess, sys, time

root=pathlib.Path('/home/bistu/EvalBase')
evidence=root/'local-acceptance-evidence/performance-validation'
def record_failure(kind,error,traceback):
    (evidence/'runner-failed.json').write_text(json.dumps({'error':str(error),'at':time.time()}))
    sys.__excepthook__(kind,error,traceback)
sys.excepthook=record_failure
def guard():
    if (evidence/'STOP.json').exists(): raise RuntimeError('safety_stop')
while not (evidence/'idle-complete').exists():
    if (evidence/'STOP.json').exists(): raise RuntimeError('safety_stop')
    time.sleep(5)
browser_command=['docker','run','--rm','--name','evalbase-performance-validation-browser','--label','com.docker.compose.project=evalbase-performance-validation','--network','host','--cpus=1','--memory=2g','--memory-swap=2g','--user','1000:1000','-e','PERF_PASSWORD','-v',str(root)+':/workspace:ro','-v',str(root/'.scratch/performance-validation')+':/harness:ro','-v',str(evidence)+':/evidence','mcr.microsoft.com/playwright:v1.62.1-noble','node','/harness/browser.mjs']
guard()
with (evidence/'browser.log').open('w') as log:
    result=subprocess.run(browser_command,stdout=log,stderr=subprocess.STDOUT)
if result.returncode or not (evidence/'browser-complete').exists(): raise RuntimeError('browser_prerequisite_failed')
def driver_command(mode, run):
    return ['docker','run','--rm','--name','evalbase-performance-validation-load','--label','com.docker.compose.project=evalbase-performance-validation','--cpus=1','--memory=2g','--memory-swap=2g','--network','evalbase-performance-validation-internal','--user','1000:1000','-e','PERF_PASSWORD','-e',f'PERF_RUN={run}','-v',str(root/'.scratch/performance-validation')+':/harness:ro','-v',str(evidence)+':/evidence','evalbase-architecture-performance:1d62240','node','/harness/driver.mjs',mode]
guard()
with (evidence/'baseline.log').open('w') as log:
    result=subprocess.run(driver_command('baseline','baseline'),stdout=log,stderr=subprocess.STDOUT)
if result.returncode: raise RuntimeError('baseline_failed')
for users in [2,3]:
    for repeat in [1,2,3]:
        if (evidence/'STOP.json').exists(): raise RuntimeError('safety_stop')
        (evidence/'schedule.json').write_text(json.dumps({'users':users,'run':repeat,'started':time.time(),'totalRuns':6}))
        command=driver_command('load',f'mixed-{users}-{repeat}')+[str(users),str(repeat)]
        with (evidence/f'load-{users}-{repeat}.log').open('w') as log:
            result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
        if result.returncode:
            (evidence/'runner-failed.json').write_text(json.dumps({'users':users,'run':repeat,'exitCode':result.returncode}))
            raise RuntimeError('load_run_failed')
        time.sleep(10)
(evidence/'mixed-complete').write_text('passed')
