import json, pathlib, statistics, sys

folder=sys.argv[1] if len(sys.argv)>1 else 'performance-repair-2026-10-03'
assert folder in ['performance-repair-2026-10-03','performance-repair-review-2026-10-03/normal-retest']
d=pathlib.Path('/home/bistu/EvalBase/local-acceptance-evidence')/folder
evidence=d.parent if folder.endswith('/normal-retest') else d
assert not (d/'aggregate.json').exists(),'evidence_already_exists'
out={'normal':{},'heavy':{},'profile':{},'resources':{}}
def metric(values):
    ordered=sorted(values)
    return {'n':len(values),'medianMs':statistics.median(values),'maxMs':max(values),'p95Ms':ordered[max(0,__import__('math').ceil(len(ordered)*.95)-1)]}
for variant in ['baseline','optimized']:
    bench=json.loads((d/f'bench-{variant}.json').read_text());assert not bench.get('error'),bench.get('error')
    out['normal'][variant]={}
    stages={s['stage'] for s in bench['samples'] if 'ms' in s}
    for stage in sorted(stages):
        rows=[s for s in bench['samples'] if s['stage']==stage and 'ms' in s]
        if stage.startswith('normal'):
            out['normal'][variant][stage]=metric([s['ms'] for s in rows])
        else:
            out['heavy'].setdefault(variant,{})[stage]=[{'users':s['users'],'run':s['run'],'ms':s['ms'],'peakRssBytes':s['peakRss'],'peakHeapBytes':s['peakHeap']} for s in rows]
    for s in bench['samples']:
        if not s.get('observations'):continue
        for kind in ['read','save']:
            values=[a['ms'] for a in s['observations'] if isinstance(a,dict) and a['kind']==kind] if isinstance(s['observations'][0],dict) else (s['observations'] if kind=='read' else [])
            if values:out['heavy'][variant].setdefault(s['stage'],[]).append({'users':s['users'],'run':s['run'],'kind':kind,**metric(values)})
    p=json.loads((d/f'profile-{variant}.json').read_text())
    for vid in ['repair-profile-v1','repair-profile-v2']:
        for suffix in sorted({r['suffix'] for r in p['requests']}):
            for cache in sorted({r.get('cache','mixed') for r in p['requests'] if r['id']==vid and r['suffix']==suffix}):
                values=[r['ms'] for r in p['requests'] if r['id']==vid and r['suffix']==suffix and r.get('cache','mixed')==cache]
                out['profile'].setdefault(variant,{})[vid+suffix+' '+cache]=metric(values)
requests={v:[json.loads(s) for s in (d/f'bench-requests-{v}.jsonl').read_text().splitlines()] for v in ['baseline','optimized']}
out['http']={v:{'requests':len(rows),'errors':sum(bool(r['error']) for r in rows),'statusCounts':{str(k):sum(r['status']==k for r in rows) for k in sorted({r['status'] for r in rows})}} for v,rows in requests.items()}
resources=[json.loads(s) for s in (d/'resources.jsonl').read_text().splitlines()]
out['resources']={'samples':len(resources),'hostMemAvailableMinBytes':min(r['hostMemAvailableBytes'] for r in resources),'diskAvailableMinBytes':min(r['diskAvailableBytes'] for r in resources),'sharedHealthFailures':sum(any(v.get('status')!='ok' if isinstance(v,dict) else True for v in r.get('sharedHealth',{}).values()) for r in resources),'monitorErrors':sum('error' in r for r in resources),'stop':(evidence/'STOP.json').exists(),'containers':{}}
for name in sorted({name for r in resources for name in r.get('containers',{})}):
    rows=[r['containers'][name] for r in resources if name in r.get('containers',{})]
    out['resources']['containers'][name]={'peakBytes':max(int(r['memory.current']) for r in rows),'oomKilled':any(r['oomKilled'] for r in rows),'restartsMax':max(r['restarts'] for r in rows)}
a=json.loads((d/'profile-baseline.json').read_text());b=json.loads((d/'profile-optimized.json').read_text())
assert [(r['id'],r['run'],r['suffix'],r.get('cache'),r['sha256']) for r in a['requests']]==[(r['id'],r['run'],r['suffix'],r.get('cache'),r['sha256']) for r in b['requests']]
assert json.loads((d/'bench-csv-hashes-baseline.json').read_text())==json.loads((d/'bench-csv-hashes-optimized.json').read_text())
out['hashes']={'profileResponsesIdentical':len(a['requests']),'nativeCsvTypesIdentical':2}
(d/'aggregate.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps({'normal':out['normal'],'resources':out['resources'],'http':out['http']},ensure_ascii=False))
