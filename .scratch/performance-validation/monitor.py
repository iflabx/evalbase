import json, os, pathlib, subprocess, time, urllib.request

root = pathlib.Path('/home/bistu/EvalBase')
evidence = root / 'local-acceptance-evidence/performance-validation'
project = 'evalbase-performance-validation'
names = [f'{project}-{service}-1' for service in ['web','worker','postgres','minio']]
load_names = [f'{project}-load', f'{project}-browser']
high_memory = {}
last_oom = {}
bad_health = 0
shared_health_failures = {}
monitor_failures = 0
iteration = 0
queue_progress_at = time.time()
previous_finished = None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=8)
    if result.returncode:
        raise RuntimeError('command_failed_' + args[0])
    return result.stdout

def http(path):
    with opener.open('http://127.0.0.1:4240' + path, timeout=3) as response:
        return response.read().decode()

def stop(reason):
    if not (evidence/'STOP.json').exists():
        (evidence / 'STOP.json').write_text(json.dumps({'reason':reason,'at':time.time()}))
    for name in load_names:
        subprocess.run(['docker','stop','--time','5',name],capture_output=True,timeout=10)

while not (evidence / 'monitor-finish').exists():
    sample = {'at':time.time()}
    try:
        if (evidence/'STOP.json').exists(): stop('already_stopped')
        sample['diskAvailableBytes'] = os.statvfs(root).f_bavail * os.statvfs(root).f_frsize
        mem = dict((line.split(':')[0],int(line.split()[1])*1024) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
        sample['hostMemAvailableBytes'] = mem['MemAvailable']
        sample['hostCpu'] = pathlib.Path('/proc/stat').read_text().splitlines()[0]
        sample['hostLoad'] = os.getloadavg()
        sample['pressure'] = {name:pathlib.Path('/proc/pressure/'+name).read_text().strip() for name in ['cpu','memory','io']}
        sample['containers'] = {}
        ids = command(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project]).split()
        containers = json.loads(command(['docker','inspect',*ids])) if ids else []
        observed = set()
        for item in containers:
            name=item['Name']; observed.add(name.lstrip('/'))
            state=item['State'];pid=str(state['Pid']);restarts=item['RestartCount'];oom=state['OOMKilled']
            data={'restarts':restarts,'oomKilled':oom,'running':state['Running'],'exitCode':state['ExitCode'],'health':state.get('Health',{}).get('Status')}
            sample['containers'][name]=data
            if name.lstrip('/') in names and (not state['Running'] or oom or restarts or data['health']=='unhealthy'):
                stop('required_container_unavailable_'+name)
            if pid=='0': continue
            path = pathlib.Path('/proc/'+pid+'/cgroup').read_text().strip().split('::')[1]
            group = pathlib.Path('/sys/fs/cgroup') / path.lstrip('/')
            data.update({key:(group/key).read_text().strip() for key in ['memory.current','memory.max','memory.events','cpu.stat','cpu.max','io.stat']})
            limit,current = int(data['memory.max']),int(data['memory.current'])
            high_memory[name] = high_memory.get(name,0)+1 if current>limit*.9 else 0
            oom_count = int(dict(line.split() for line in data['memory.events'].splitlines())['oom_kill'])
            if high_memory[name]>=12 or oom or oom_count>last_oom.get(name,0):
                stop('container_memory_or_oom_'+name)
            last_oom[name]=oom_count
        if not set(names).issubset(observed): stop('required_container_missing')
        sample['metrics'] = http('/metrics')
        sample['ready'] = json.loads(http('/health/ready'))
        if sample['ready'].get('status')!='ok':
            bad_health += 1
        else:
            bad_health = 0
        if iteration%6==0:
            sql = "SELECT json_build_object('connections',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()),'active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()),'waitingLocks',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'),'databaseBytes',pg_database_size(current_database()),'jobs',(SELECT json_agg(x) FROM (SELECT status,count(*) FROM job GROUP BY status) x));"
            sample['database'] = json.loads(command(['docker','exec','-e','PGAPPNAME=performance-monitor',names[2],'psql','-U','performance_validation','-d','evalbase_performance_validation','-At','-c',sql]))
            jobs={row['status']:row['count'] for row in (sample['database']['jobs'] or [])}
            finished=sum(jobs.get(status,0) for status in ['succeeded','failed','cancelled'])
            pending=sum(jobs.get(status,0) for status in ['queued','running'])
            if pending==0 or previous_finished!=finished: queue_progress_at=time.time()
            previous_finished=finished
            sample['queueNoProgressSeconds']=time.time()-queue_progress_at
            if pending and sample['queueNoProgressSeconds']>=300: stop('queue_no_progress_five_minutes')
            sample['otherEvalBaseReady']={}
            for label,url in [('formal','http://121.194.33.35:3000/health/ready'),('owner','http://127.0.0.1:4217/health/ready')]:
                try:
                    with opener.open(url,timeout=3) as response: shared=json.loads(response.read())
                    sample['otherEvalBaseReady'][label]=shared
                    shared_health_failures[label]=0 if shared.get('status')=='ok' else shared_health_failures.get(label,0)+1
                except Exception as error:
                    sample['otherEvalBaseReady'][label]={'probeError':type(error).__name__}
                    shared_health_failures[label]=shared_health_failures.get(label,0)+1
                if shared_health_failures[label]>=3: stop('other_evalbase_health_'+label)
        if sample['diskAvailableBytes'] < 20*1024**3 or sample['hostMemAvailableBytes']<8*1024**3:
            stop('host_disk_or_memory_budget')
        if bad_health>=3:
            stop('health_failed_three_samples')
        monitor_failures=0
    except Exception as error:
        sample['monitorError'] = str(error)
        monitor_failures += 1
        if monitor_failures>=3:
            stop('monitor_or_health_unavailable')
    with (evidence/'resources.jsonl').open('a') as stream:
        stream.write(json.dumps(sample)+'\n')
    iteration+=1
    time.sleep(5)
