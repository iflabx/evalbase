import {createRequire} from 'node:module';
import {writeFile,access} from 'node:fs/promises';
import {readFixture,request,login,versionPath,setPhase,evidence} from './common.mjs';
const {Pool}=createRequire('/app/package.json')('pg');
const db=new Pool({connectionString:'postgresql://performance_validation:synthetic-performance-only@postgres:5432/evalbase_performance_validation',max:1,application_name:'performance-diagnosis'});
const f=await readFixture(),result={plans:[],cachedExports:[]};
const query="WITH visible_version AS MATERIALIZED (\n          SELECT v.id,ts.project_id FROM test_set ts JOIN test_set_version v ON v.test_set_id=ts.id\n          WHERE ts.project_id=$1 AND ts.id=$2 AND v.id=$3 AND ts.status='available' AND v.status='published'\n        ), all_records AS MATERIALIZED (\n          SELECT vm.ordinal,cr.input,cr.expected_output,cr.metadata,cr.origin_kind,cr.origin_ref,da.file_name\n          FROM visible_version v CROSS JOIN LATERAL resolve_version_members(v.id) vm\n          JOIN case_revision cr ON cr.id=vm.case_revision_id\n          LEFT JOIN data_asset da ON da.id=cr.origin_ref->>'assetId' AND da.project_id=v.project_id\n        ), filtered AS MATERIALIZED (SELECT * FROM all_records cr WHERE true)\n        SELECT EXISTS(SELECT 1 FROM visible_version) AS visible,\n          (SELECT count(*)::integer FROM filtered) AS total,\n          coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.ordinal) FROM\n            (SELECT * FROM filtered ORDER BY ordinal LIMIT $4 OFFSET $5) p),'[]'::jsonb) AS records,\n          coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.name) FROM\n            (SELECT DISTINCT origin_ref->>'assetId' AS id,file_name AS name FROM all_records\n             WHERE origin_kind='source_record' AND file_name IS NOT NULL) f),'[]'::jsonb) AS source_files,\n          coalesce((SELECT jsonb_agg(key ORDER BY key) FROM (\n            SELECT DISTINCT entry->>'key' AS key FROM all_records\n            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'entries')='array'\n              THEN metadata->'entries' ELSE '[]'::jsonb END) entry\n            UNION SELECT 'Metadata' FROM all_records WHERE jsonb_typeof(metadata->'entries') IS DISTINCT FROM 'array'\n          ) fields WHERE key IS NOT NULL AND key<>''),'[]'::jsonb) AS metadata_fields";
const allowed=new Set(['Node Type','Relation Name','Join Type','Plan Rows','Actual Rows','Actual Loops','Actual Total Time','Actual Startup Time','Shared Hit Blocks','Shared Read Blocks','Temp Read Blocks','Temp Written Blocks','Sort Method','Sort Space Used','Sort Space Type','Planning Time','Execution Time','Plans','Plan']);
function strip(value){if(Array.isArray(value))return value.map(strip);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>allowed.has(k)).map(([k,v])=>[k,strip(v)]));return value;}
function counters(text){return Object.fromEntries(text.split('\n').filter(s=>/^evalbase_(sql_duration_seconds_(count|sum)|pool_wait_duration_seconds_(count|sum)|sql_errors_total) /.test(s)).map(s=>{const [k,v]=s.split(' ');return [k,Number(v)];}));}
try{
  await db.query("SET statement_timeout='10s'");await db.query("SET lock_timeout='1s'");
  for(const sample of [f.samples.find(s=>s.rows===100&&!s.parentVersionId),f.loadSample]){
    const plan=await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query,[f.project,sample.testSetId,sample.versionId,20,0]);
    result.plans.push({rows:sample.rows,queryTemplate:query,plan:strip(plan.rows[0]['QUERY PLAN'])});
  }
  if(!await access(evidence+'/STOP.json').then(()=>true,()=>false)){
    setPhase('post-load-diagnosis');const admin=await login('admin');
    for(let i=0;i<2;i++){
      const cache=await db.query("SELECT count(*)::int AS n FROM version_export_cache WHERE version_id=$1 AND export_type='data.csv' AND serializer_version=1",[f.loadSample.versionId]);
      const before=counters((await request(null,'GET','/metrics',undefined,{label:'diagnostic-metrics'})).text);
      const response=await request(admin,'GET',versionPath(f)+'/data.csv',undefined,{label:'diagnostic-cached-export'});
      const after=counters((await request(null,'GET','/metrics',undefined,{label:'diagnostic-metrics'})).text);
      result.cachedExports.push({cachedRows:cache.rows[0].n,clientMs:response.ms,bytes:response.bytes,metricDelta:Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]])),observerQueriesIncluded:true});
    }
  }else result.httpNotExecuted='safety-stop';
}catch(error){result.error=error.message.slice(0,160);process.exitCode=1;}
finally{await writeFile(evidence+'/diagnostic-result.json',JSON.stringify(result,null,2));await db.end();}
