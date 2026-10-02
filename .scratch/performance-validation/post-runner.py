import json, os, pathlib, subprocess, time

root=pathlib.Path('/home/bistu/EvalBase')
evidence=root/'local-acceptance-evidence/performance-validation'
def guard():
    if any((evidence/name).exists() for name in ['STOP.json','runner-failed.json','failure.json','fixed-failure.json','heavy-failure.json','browser-heavy-failure.json']): raise RuntimeError('previous_stage_failed')

def wait_file(name,child=None,timeout=None):
    started=time.monotonic()
    while True:
        guard()
        if (evidence/name).exists(): return
        if child is not None and child.poll() is not None: raise RuntimeError(name+'_child_exited')
        if timeout is not None and time.monotonic()-started>=timeout: raise RuntimeError(name+'_timeout')
        time.sleep(1)

def stop_loads():
    for name in ['evalbase-performance-validation-load','evalbase-performance-validation-browser']:
        subprocess.run(['docker','stop','--time','5',name],capture_output=True,timeout=10)
def driver(script,run,extra=()):
    return ['docker','run','--rm','--name','evalbase-performance-validation-load','--label','com.docker.compose.project=evalbase-performance-validation','--cpus=1','--memory=2g','--memory-swap=2g','--network','evalbase-performance-validation-internal','--user','1000:1000','-e','PERF_PASSWORD','-e',f'PERF_RUN={run}',*extra,'-v',str(root/'.scratch/performance-validation')+':/harness:ro','-v',str(evidence)+':/evidence','evalbase-architecture-performance:1d62240','node','/harness/'+script]
def browser(script):
    return ['docker','run','--rm','--name','evalbase-performance-validation-browser','--label','com.docker.compose.project=evalbase-performance-validation','--network','host','--cpus=1','--memory=2g','--memory-swap=2g','--user','1000:1000','-e','PERF_PASSWORD','-v',str(root)+':/workspace:ro','-v',str(root/'.scratch/performance-validation')+':/harness:ro','-v',str(evidence)+':/evidence','mcr.microsoft.com/playwright:v1.62.1-noble','node','/harness/'+script]
def checked(command,log):
    guard()
    with (evidence/log).open('w') as out:
        result=subprocess.Popen(command,stdout=out,stderr=subprocess.STDOUT)
        while result.poll() is None:
            try: guard()
            except Exception:
                stop_loads();result.wait(timeout=15);raise
            time.sleep(1)
    if result.returncode: raise RuntimeError(log+'_failed')
try:
    wait_file('mixed-complete')
    resumed=os.environ.get('PERF_RESUME_AFTER_OVERSIZE')=='1'
    if not resumed: checked(driver('fixed.mjs','fixed'),'fixed.log')
    else: wait_file('fixed-complete')
    guard()
    with (evidence/'browser-heavy.log').open('w') as out:
        probe=subprocess.Popen(browser('browser-heavy.mjs'),stdout=out,stderr=subprocess.STDOUT)
        try:
            wait_file('browser-probe-ready',probe,60)
            extra=('-e','PERF_BROWSER_PROBE=1')
            if resumed: extra+=('-e','PERF_SKIP_KNOWN_OVERSIZE=1','-e','PERF_CASES=row-file-and-normalized-byte-boundaries,two-heavy-publications-with-viewer-probe,background-checkpoint-with-export,version-filters-and-long-empty-metadata,list-scales-and-legacy-read-compatibility,version-chain-branches-trash-and-tombstone')
            checked(driver('heavy.mjs','heavy-resume' if resumed else 'heavy',extra),'heavy-resume.log' if resumed else 'heavy.log')
        finally:
            try: probe.wait(timeout=30)
            except subprocess.TimeoutExpired:
                subprocess.run(['docker','stop','--time','5','evalbase-performance-validation-browser'],capture_output=True,timeout=10)
                probe.wait(timeout=10)
    if probe.returncode: raise RuntimeError('heavy_browser_failed')
    checked(browser('browser-list.mjs'),'browser-list.log')
    checked(driver('diagnose.mjs','diagnostic'),'diagnostic.log')
    guard()
    (evidence/'all-stages-complete').write_text('completed-with-known-oversize-failure' if resumed else 'passed')
except Exception as error:
    stop_loads()
    (evidence/'post-runner-failed.json').write_text(json.dumps({'error':str(error),'at':time.time()}))
    raise
