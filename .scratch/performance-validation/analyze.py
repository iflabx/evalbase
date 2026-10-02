import collections, datetime, json, math, pathlib, statistics, sys

directory=pathlib.Path(sys.argv[1])
def lines(path):
    with path.open(encoding='utf-8-sig') as stream:
        for line in stream:
            try: yield json.loads(line)
            except json.JSONDecodeError: pass # The last line can still be being appended during progress snapshots.
def summary(values):
    if not values: return {}
    ordered=sorted(values)
    quantile=lambda q:round(ordered[math.ceil(q*len(ordered))-1],3)
    return {'n':len(values),'p50':quantile(.5),'p95Observed':quantile(.95),'p99Observed':quantile(.99),'max':round(max(values),3),'p95Sufficient':len(values)>=200,'p99Sufficient':len(values)>=1000}
groups=collections.defaultdict(list)
failures=[]
completed_ids=set()
for path in sorted(directory.glob('requests-*.jsonl')):
    for row in lines(path):
        groups[(path.stem.removeprefix('requests-'),row['phase'],row['action'])].append(row)
        if row.get('id'):completed_ids.add(row['id'])
        if row['error']: failures.append({**row,'run':path.stem})
request_results=[]
for (run,phase,action),rows in groups.items():
    request_results.append({'run':run,'phase':phase,'action':action,**summary([r['ms'] for r in rows]),'bytes':summary([r['bytes'] for r in rows]),'statuses':dict(collections.Counter(r['status'] for r in rows)),'failures':sum(r['error'] is not None for r in rows),'first':rows[0]['at'],'last':rows[-1]['at']})
resources={};previous={};times=[];disk=[];memory=[];db=[];monitor_errors=[];metric_peaks=collections.defaultdict(float)
path=directory/'resources.jsonl'
if path.exists():
    for row in lines(path):
        times.append(row['at']);disk.append(row.get('diskAvailableBytes',math.inf));memory.append(row.get('hostMemAvailableBytes',math.inf))
        if 'monitorError' in row: monitor_errors.append({'at':row['at'],'error':row['monitorError']})
        if row.get('database'): db.append(row['database'])
        for metric in row.get('metrics','').splitlines():
            if metric.startswith(('evalbase_pool_waiting_connections ','evalbase_pool_connections ','evalbase_process_resident_memory_bytes ','evalbase_process_heap_used_bytes ','evalbase_event_loop_delay_seconds ','evalbase_event_loop_delay_max_seconds ')):
                name,value=metric.split();metric_peaks[name]=max(metric_peaks[name],float(value))
        for name,data in row.get('containers',{}).items():
            values=resources.setdefault(name,{'memoryPeakBytes':0,'cpuPercentSamples':[],'restarts':0,'oom':False})
            values['restarts']=max(values['restarts'],data['restarts']);values['oom']|=data['oomKilled']
            for key in ['running','exitCode','health']:
                if key in data:values[key]=data[key]
            if 'cpu.max' not in data: continue
            values.update({'cpuLimit':data['cpu.max'],'memoryLimit':data['memory.max']})
            values['memoryPeakBytes']=max(values['memoryPeakBytes'],int(data['memory.current']))
            cpu=dict(line.split() for line in data['cpu.stat'].splitlines());usage=int(cpu['usage_usec'])
            if name in previous:
                before,used=previous[name]
                if usage>=used and row['at']>before: values['cpuPercentSamples'].append((usage-used)/(row['at']-before)/10000)
            previous[name]=(row['at'],usage)
for name,value in resources.items():
    value['cpuPercent']=summary(value.pop('cpuPercentSamples'))
result={'requests':request_results,'unexpectedRequestFailures':failures,'containers':resources,'runtimeMetricPeaks':dict(metric_peaks),'host':{'diskMinAvailableBytes':min(disk,default=None),'memoryMinAvailableBytes':min(memory,default=None),'monitorErrors':monitor_errors,'maximumSamplingGapSeconds':max([b-a for a,b in zip(times,times[1:])],default=0)},'database':{'connectionsPeak':max([r['connections'] for r in db],default=0),'activePeak':max([r['active'] for r in db],default=0),'waitingLocksPeak':max([r['waitingLocks'] for r in db],default=0)}}
result['unfinishedRequests']=[{**row,'run':path.stem} for path in sorted(directory.glob('request-starts-*.jsonl')) for row in lines(path) if row['id'] not in completed_ids]
result['stageMarkers']={path.name:(json.loads(path.read_text()) if path.suffix=='.json' else path.read_text()) for path in directory.iterdir() if path.name=='STOP.json' or 'failed' in path.name or 'failure' in path.name or path.name.endswith('-complete')}
for filename in ['browser-result.json','idle-result.json','browser-version.json','list-browser-result.json']:
    path=directory/filename
    if path.exists():result[filename.removesuffix('.json')]=json.loads(path.read_text())
if (directory/'fixed-arrivals.jsonl').exists():
    arrivals=list(lines(directory/'fixed-arrivals.jsonl'))
    scheduled=list(lines(directory/'fixed-scheduled.jsonl')) if (directory/'fixed-scheduled.jsonl').exists() else []
    result['fixedArrivals']={u:{'wait':summary([r['waitMs'] for r in arrivals if r['users']==u]),'response':summary([r['responseMs'] for r in arrivals if r['users']==u and 'responseMs' in r]),'scheduledToComplete':summary([r['totalMs'] for r in arrivals if r['users']==u]),'statuses':dict(collections.Counter(r['status'] for r in arrivals if r['users']==u)),'unfinished':sum(r['users']==u for r in scheduled)-sum(r['users']==u for r in arrivals)} for u in [2,3]}
(directory/'aggregate.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'requestGroups':len(request_results),'unexpectedFailures':len(failures),'containers':len(resources),'maximumSamplingGapSeconds':result['host']['maximumSamplingGapSeconds']},ensure_ascii=False))
