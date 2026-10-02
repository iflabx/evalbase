import json, os, pathlib, re, subprocess, sys, time, urllib.request

root=pathlib.Path('/home/bistu/EvalBase')
review=len(sys.argv)>2 and sys.argv[2]=='review'
assert len(sys.argv)<3 or review
project='evalbase-performance-repair'+('-review' if review else '')
evidence=root/('local-acceptance-evidence/performance-repair'+('-review' if review else '')+'-2026-10-03')
attempt=sys.argv[1] if len(sys.argv)>1 else None
assert not attempt or re.fullmatch(r'[a-z0-9-]+',attempt)
out=evidence/attempt if attempt else evidence
out.mkdir(parents=True,exist_ok=True)
names=[project+'-'+s+'-1' for s in ['test','postgres','minio']]
counts={}; health={}; failures=0; started=time.time()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def stop(reason):
    marker=evidence/'STOP.json'
    if not marker.exists(): marker.write_text(json.dumps({'reason':reason,'at':time.time()}))
    subprocess.run(['docker','stop','--time','5',names[0]],capture_output=True,timeout=10)

while not (out/'monitor-finish').exists() and not (evidence/'STOP.json').exists():
    row={'at':time.time()}
    try:
        row['diskAvailableBytes']=os.statvfs(root).f_bavail*os.statvfs(root).f_frsize
        mem={line.split(':')[0]:int(line.split()[1])*1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines()}
        row['hostMemAvailableBytes']=mem['MemAvailable']
        row['hostLoad']=os.getloadavg()
        row['pressure']={p:pathlib.Path('/proc/pressure/'+p).read_text().strip() for p in ['cpu','memory','io']}
        items=json.loads(subprocess.check_output(['docker','inspect',*names],text=True,timeout=5))
        row['containers']={}
        for item in items:
            name=item['Name']; state=item['State']
            if not state['Running'] or state['OOMKilled'] or item['RestartCount'] or state.get('Health',{}).get('Status')=='unhealthy': stop('required_container_unavailable_'+name)
            pid=str(state['Pid'])
            if pid=='0': continue
            group=pathlib.Path('/sys/fs/cgroup')/pathlib.Path('/proc/'+pid+'/cgroup').read_text().strip().split('::')[1].lstrip('/')
            data={p:(group/p).read_text().strip() for p in ['memory.current','memory.max','memory.stat','memory.events','cpu.stat','io.stat']}
            data.update({'restarts':item['RestartCount'],'oomKilled':state['OOMKilled']})
            row['containers'][name]=data
            counts[name]=counts.get(name,0)+1 if int(data['memory.current'])>int(data['memory.max'])*.9 else 0
            if counts[name]>=30 or int(dict(line.split() for line in data['memory.events'].splitlines())['oom_kill']): stop('container_memory_or_oom_'+name)
        row['sharedHealth']={}
        for label,url in [('formal','http://121.194.33.35:3000/health/ready'),('owner','http://127.0.0.1:4217/health/ready')]:
            try:
                with opener.open(url,timeout=3) as response: data=json.loads(response.read())
                row['sharedHealth'][label]=data
                health[label]=0 if data.get('status')=='ok' else health.get(label,0)+1
            except Exception as error:
                row['sharedHealth'][label]=type(error).__name__; health[label]=health.get(label,0)+1
            if health[label]>=3: stop('shared_health_'+label)
        if row['diskAvailableBytes']<20*1024**3 or row['hostMemAvailableBytes']<8*1024**3: stop('host_disk_or_memory_budget')
        if time.time()-started>1800: stop('short_test_deadline')
        failures=0
    except Exception as error:
        row['error']=str(error); failures+=1
        if failures>=3: stop('monitor_unavailable')
    with (out/'resources.jsonl').open('a') as stream: stream.write(json.dumps(row)+'\n')
    time.sleep(2)
