import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import pg from 'pg';

const variant=process.argv[2]; assert(['baseline','optimized'].includes(variant));
const root=variant==='baseline'?resolve('.scratch/performance-repair/baseline'):resolve('.');
const {buildApp}=await import(pathToFileURL(root+'/src/server/app.ts').href);
const {migrate}=await import(pathToFileURL(root+'/src/db/migrate.ts').href);
const {loadConfig}=await import(pathToFileURL(root+'/src/config.ts').href);
const config=loadConfig();
const review=config.databaseUrl.endsWith('/evalbase_performance_repair_review');
assert(review||config.databaseUrl.endsWith('/evalbase_performance_repair'));
assert(config.minio.bucket===`evalbase-performance-repair${review?'-review':''}-tests`);
const evidence=`local-acceptance-evidence/performance-repair${review?'-review':''}-2026-10-03`;
const attempt=process.argv[3]??'profile-replay';assert(/^[a-z0-9-]+$/.test(attempt));
const dir=evidence+'/'+attempt;
const checkStop=async()=>assert(!await access(evidence+'/STOP.json').then(()=>true,()=>false),'safety_stop');
await checkStop();
await mkdir(dir,{recursive:true});
assert(!await access(dir+`/profile-${variant}.json`).then(()=>true,()=>false),'evidence_already_exists');
const schema='repair_profile_'+variant+'_'+randomUUID().replaceAll('-','');
const adminDb=new pg.Pool({connectionString:config.databaseUrl,max:1});
await adminDb.query('CREATE SCHEMA '+schema);
const url=new URL(config.databaseUrl);url.searchParams.set('options','-csearch_path='+schema);
const db=new pg.Pool({connectionString:url.toString(),max:1});
await migrate(url.toString());
const app=await buildApp({databaseUrl:url.toString(),soloOwnerMode:true});
const login=await app.inject({method:'POST',url:'/api/session',headers:{origin:config.appOrigin},payload:{}});
assert.equal(login.statusCode,200);
const headers={cookie:`${login.cookies[0].name}=${login.cookies[0].value}`,origin:config.appOrigin,'x-csrf-token':login.json().csrfToken};
let fixture: {project:string,set:string};
{
  const project=await app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'性能修复合成数据'}});
  assert.equal(project.statusCode,201);
  fixture={project:project.json().project.id,set:'repair-profile-set'};
  const owner=(await db.query('SELECT owner_id FROM project WHERE id=$1',[fixture.project])).rows[0].owner_id;
  await db.query(`INSERT INTO test_set(id,project_id,name,purpose,owner_id) VALUES($1,$2,'万条版本','合成数据',$3)`,[fixture.set,fixture.project,owner]);
  await db.query(`INSERT INTO formal_schema_revision(id,test_set_id,mode,input_schema,expected_output_schema) VALUES('repair-profile-schema',$1,'gold_required','{}','{}')`,[fixture.set]);
  await db.query(`INSERT INTO working_draft(id,test_set_id,status,updated_by) VALUES('repair-profile-draft',$1,'editing',$2)`,[fixture.set,owner]);
  await db.query(`INSERT INTO candidate_snapshot(id,draft_id,status) VALUES('repair-profile-candidate1','repair-profile-draft','published_as_version'),('repair-profile-candidate2','repair-profile-draft','published_as_version')`);
  for (const n of [1,2]) await db.query(`INSERT INTO test_set_version(id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,published_at,parent_version_id,publication_order,generation,version_label,storage_format)
    VALUES($1,$2,$3,$4,'repair-profile-schema',repeat('a',64),repeat('a',64),repeat('a',64),'synthetic/profile',10000,$5,now(),$6,$3,$3,$7,$8)`,[`repair-profile-v${n}`,fixture.set,n,`repair-profile-candidate${n}`,owner,n===2?'repair-profile-v1':null,`v${n}`,n===1?'legacy_full_v1':'delta_v1']);
  await db.query(`INSERT INTO test_case(id,test_set_id) SELECT 'repair-profile-case-'||n,$1 FROM generate_series(1,10000)n`,[fixture.set]);
  await db.query(`INSERT INTO case_revision(id,case_id,input,expected_output,metadata,source_record_ordinal,content_hash,lineage_fingerprint,origin_kind)
    SELECT 'repair-profile-rev-'||n,'repair-profile-case-'||n,jsonb_build_object('question','问题'||lpad(n::text,5,'0')),jsonb_build_object('text','答案'||n),jsonb_build_object('entries',jsonb_build_array(jsonb_build_object('key','主题','value','主题'||n%5))),1,repeat('a',64),repeat('a',64),'manual' FROM generate_series(1,10000)n`);
  await db.query(`INSERT INTO version_member(version_id,case_revision_id,ordinal) SELECT 'repair-profile-v1','repair-profile-rev-'||n,n FROM generate_series(1,10000)n`);
  await db.query(`INSERT INTO version_checkpoint(version_id,reason,retention_class,item_count,members_hash) VALUES('repair-profile-v2','periodic','rebuildable',10000,repeat('a',64))`);
  await db.query(`INSERT INTO version_checkpoint_member(version_id,position,case_id,case_revision_id) SELECT 'repair-profile-v2',n,'repair-profile-case-'||n,'repair-profile-rev-'||n FROM generate_series(1,10000)n`);
  await db.query(`UPDATE version_checkpoint SET members_hash=checkpoint_members_hash(version_id) WHERE version_id='repair-profile-v2'`);
  await db.query('ANALYZE');
  await writeFile(dir+`/profile-fixture-${variant}.json`,JSON.stringify({...fixture,schema,source:root}));
}
const query=JSON.parse(await readFile('.scratch/performance-repair/wide-query.json','utf8')) as string;
const output={variant,schema,source:root,plans:[] as unknown[],requests:[] as unknown[]};
try {
  await db.query(`SET statement_timeout='20s'`);
  for (const id of ['repair-profile-v1','repair-profile-v2']) for (const jit of ['on','off']) {
    await db.query('SET jit='+jit);
    for (let run=1;run<=3;run++) {
      await checkStop();
      const plan=await db.query('EXPLAIN(ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) '+query,[fixture.project,fixture.set,id,20,4980]);
      output.plans.push({id,jit,run,plan:plan.rows[0]['QUERY PLAN']});
    }
  }
  for (const id of ['repair-profile-v1','repair-profile-v2']) {
    const prefix=`/api/projects/${fixture.project}/solo-test-sets/${fixture.set}/versions/${id}`;
    for (let run=1;run<=3;run++) for (const suffix of ['/records?limit=20&offset=4980','/records?limit=20&search=099']) {
      await checkStop();
      const at=performance.now();const response=await app.inject({method:'GET',url:prefix+suffix,headers});const ms=performance.now()-at;
      assert.equal(response.statusCode,200,response.body.slice(0,160));
      if(suffix.includes('records?limit=20&offset')) {assert.equal(response.json().pagination.total,10000);assert.equal(response.json().records.length,20);}
      output.requests.push({id,run,suffix,ms,bytes:Buffer.byteLength(response.body),sha256:createHash('sha256').update(response.body).digest('hex')});
    }
    for (const suffix of ['/data.csv','/provenance.csv']) for (let run=1;run<=3;run++) {
      await db.query('DELETE FROM version_export_cache WHERE version_id=$1',[id]);
      for (const cache of ['cold','warm']) {
        await checkStop();
        const at=performance.now();const response=await app.inject({method:'GET',url:prefix+suffix,headers});const ms=performance.now()-at;
        assert.equal(response.statusCode,200,response.body.slice(0,160));
        output.requests.push({id,run,suffix,cache,ms,bytes:Buffer.byteLength(response.body),sha256:createHash('sha256').update(response.body).digest('hex')});
      }
    }
  }
} finally {await writeFile(dir+`/profile-${variant}.json`,JSON.stringify(output,null,2));await app.close();await db.end();await adminDb.end();}
