import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,appendFile,access,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import pg from 'pg';

const variant=process.argv[2];assert(['baseline','optimized'].includes(variant));
const root=variant==='baseline'?resolve('.scratch/performance-repair/baseline'):resolve('.');
const {buildApp}=await import(pathToFileURL(root+'/src/server/app.ts').href);
const {migrate}=await import(pathToFileURL(root+'/src/db/migrate.ts').href);
const {loadConfig}=await import(pathToFileURL(root+'/src/config.ts').href);
const config=loadConfig();const review=config.databaseUrl.endsWith('/evalbase_performance_repair_review');
assert(review||config.databaseUrl.endsWith('/evalbase_performance_repair'));
assert(config.minio.bucket===`evalbase-performance-repair${review?'-review':''}-tests`);
const evidence=`local-acceptance-evidence/performance-repair${review?'-review':''}-2026-10-03`;
const attempt=process.argv[3];assert(!attempt||/^[a-z0-9-]+$/.test(attempt));
const dir=attempt?evidence+'/'+attempt:evidence;
const normalOnly=process.argv[4]==='normal-only';
assert(!await access(evidence+'/STOP.json').then(()=>true,()=>false),'safety_stop');
await mkdir(dir,{recursive:true});
assert(!await access(dir+`/bench-${variant}.json`).then(()=>true,()=>false),'evidence_already_exists');
const schema='repair_bench_'+variant+'_'+randomUUID().replaceAll('-','');
const adminDb=new pg.Pool({connectionString:config.databaseUrl,max:1});
await adminDb.query('CREATE SCHEMA '+schema);
const url=new URL(config.databaseUrl);url.searchParams.set('options','-csearch_path='+schema);
const db=new pg.Pool({connectionString:url.toString(),max:1});
await migrate(url.toString());
const app=await buildApp({databaseUrl:url.toString(),soloOwnerMode:false,allowTestIdentity:false},{disableLegacyTestBootstrap:true});
const base=await app.listen({host:'127.0.0.1',port:0});
const samples:any[]=[];const starts=new Date().toISOString();
let label='setup';let peakRss=0;let peakHeap=0;let project:string;let owner:string;let small:string;
const memory=setInterval(()=>{const m=process.memoryUsage();peakRss=Math.max(peakRss,m.rss);peakHeap=Math.max(peakHeap,m.heapUsed);},20);
const origin=config.appOrigin;
async function req(session:any,method:string,path:string,payload?:any,expected=[200]) {
  assert(!await access(evidence+'/STOP.json').then(()=>true,()=>false),'safety_stop');
  const at=performance.now();let status=0;let bytes=0;let error:string|null=null;let text='';let response:Response;
  try {
    response=await fetch(base+path,{method,headers:{origin,...session,...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(90000)});
    status=response.status;text=await response.text();bytes=Buffer.byteLength(text);assert(expected.includes(status),'unexpected_status_'+status+'_'+path+'_'+text.slice(0,100));
  }catch(cause){error=(cause as Error).message;throw cause;}
  finally {await appendFile(dir+`/bench-requests-${variant}.jsonl`,JSON.stringify({at:new Date().toISOString(),label,method,path,ms:performance.now()-at,status,bytes,error})+'\n');}
  return {response:response!,text,json:()=>text?JSON.parse(text):null};
}
async function measured(stage:string,users:number,run:number,work:()=>Promise<any>) {
  label=stage;const at=performance.now();peakRss=process.memoryUsage().rss;peakHeap=process.memoryUsage().heapUsed;
  const value=await work();samples.push({stage,users,run,ms:performance.now()-at,peakRss,peakHeap});return value;
}
async function login(email:string) {
  const r=await req({},'POST','/api/session',{email,password:'SyntheticRepair123!'});
  return {cookie:r.response.headers.getSetCookie()[0].split(';')[0],'x-csrf-token':r.json().csrfToken};
}
const prefix=()=>`/api/projects/${project}/collaborative-drafts`;
async function draft(name:string,bytes=0) {
  const created=(await req(sessions[0],'POST',prefix(),{},[201])).json().draft.id;
  await req(sessions[0],'PATCH',prefix()+'/'+created,{field:'name',value:name,expectedFieldRevision:0});
  const rows=10000;
  const baseBytes=1+rows*(JSON.stringify({question:'q00001',expectedOutput:'',metadata:[]}).length+1);
  const padding=bytes?Math.floor((bytes-baseBytes)/rows):10;const extra=bytes?(bytes-baseBytes)%rows:0;
  await db.query(`INSERT INTO collaborative_draft_record(draft_id,id,position,question,expected_output,metadata,source,updated_by)
    SELECT $1,$1||'-row-'||n,n,'q'||lpad(n::text,5,'0')||repeat('x',$2+CASE WHEN n=1 THEN $3 ELSE 0 END),'','[]'::jsonb,NULL,$4 FROM generate_series(1,10000)n`,[created,padding,extra,owner]);
  await db.query(`UPDATE collaborative_draft SET revision=revision+1 WHERE id=$1`,[created]);
  if(bytes) {
    const size=await db.query(`SELECT sum(octet_length(question))+sum(octet_length(expected_output)) AS text_bytes FROM collaborative_draft_record WHERE draft_id=$1`,[created]);
    assert.equal(Number(size.rows[0].text_bytes)+(baseBytes-6*rows),bytes);
  }
  return created;
}
async function publish(session:any,id:string) {
  const state=(await req(session,'GET',prefix()+'/'+id+'?limit=1')).json();
  return (await req(session,'POST',prefix()+'/'+id+'/publish',{revision:state.draft.revision},[200,201])).json();
}
const sessions:any[]=[];
async function interference(users:number,run:number,work:()=>Promise<any>) {
  let done=false;const observations:any[]=[];let readerError:Error|undefined;
  const paths=publishedPaths;
  const readers=sessions.slice(1,users).map(async (session,index)=>{
    let turn=0;
    while(!done) {
      const at=performance.now();await req(session,'GET',paths[0]+'/records?limit=20');observations.push({kind:'read',account:index+1,ms:performance.now()-at});
      if(index===0&&turn++%4===0) {
        const row=(await req(session,'GET',prefix()+'/'+small)).json().records[0];
        const at=performance.now();await req(session,'PATCH',prefix()+'/'+small+'/records/'+row.id,{field:'expectedOutput',value:`heavy-${run}-${turn}`,expectedFieldRevision:row.expectedOutputRevision});observations.push({kind:'save',account:index+1,ms:performance.now()-at});
      }
      await delay(250);
    }
  });
  const finished=Promise.all(readers).catch(error=>{readerError=error;done=true;});
  try{return await work();}finally{done=true;await finished;samples.push({stage:label+'-interference',users,run,observations});if(readerError)throw readerError;}
}
const publishedPaths:string[]=[];
let error:string|undefined;
try {
  await req({},'POST','/api/installation/administrator',{email:'admin@repair.test',displayName:'管理员',password:'SyntheticRepair123!',confirmPassword:'SyntheticRepair123!'},[201]);
  sessions.push(await login('admin@repair.test'));
  project=(await req(sessions[0],'POST','/api/projects',{name:'性能修复复测项目'},[201])).json().project.id;
  owner=(await db.query('SELECT owner_id FROM project WHERE id=$1',[project])).rows[0].owner_id;
  for(const [email,role] of [['editor@repair.test','editor'],['viewer@repair.test','viewer']]) {
    await req({},'POST','/api/accounts',{email,password:'SyntheticRepair123!',confirmPassword:'SyntheticRepair123!'},[201]);
    const session=await login(email);sessions.push(session);
    const inv=(await req(sessions[0],'POST',`/api/projects/${project}/invitations`,{email,role},[201])).json();
    await req(session,'POST',`/api/me/invitations/${inv.invitation.id}/accept`);
  }
  small=(await req(sessions[0],'POST',prefix(),{},[201])).json().draft.id;
  await req(sessions[0],'POST',prefix()+'/'+small+'/records',{question:'light-save'},[201]);
  const seed=await draft('万条复测');const publication=await measured('initial-10000-publish',1,1,()=>publish(sessions[0],seed));
  publishedPaths.push(`/api/projects/${project}/solo-test-sets/${publication.testSet.id}/versions/${publication.version.id}`);
  await db.query('ANALYZE');
  const csvHashes:Record<string,string>={};
  for(let run=1;run<=3;run++) {
    await measured('normal/records?limit=20&offset=4980',1,run,()=>req(sessions[0],'GET',publishedPaths[0]+'/records?limit=20&offset=4980'));
  }
  for(const suffix of ['/data.csv','/provenance.csv']) for(let run=1;run<=3;run++) {
    await db.query('DELETE FROM version_export_cache WHERE version_id=$1',[publication.version.id]);
    for(const cache of ['cold','warm']) {
    const result=await measured('normal-'+cache+suffix,1,run,()=>req(sessions[0],'GET',publishedPaths[0]+suffix));
    if(suffix.includes('csv')){const digest=createHash('sha256').update(result.text).digest('hex');if(csvHashes[suffix])assert.equal(digest,csvHashes[suffix]);csvHashes[suffix]=digest;}
    }
  }
  for(let run=1;run<=3;run++) {
    const row=(await req(sessions[1],'GET',prefix()+'/'+small)).json().records[0];
    await measured('normal-save',1,run,()=>req(sessions[1],'PATCH',prefix()+'/'+small+'/records/'+row.id,{field:'question',value:'save-'+run,expectedFieldRevision:row.questionRevision}));
  }
  if(!normalOnly) {
  for(const users of [2,3]) {
    const large=await draft('一亿字节发布-'+users,100000000);
    const pub=await measured('100MB-publish',users,1,()=>interference(users,1,()=>publish(sessions[0],large)));
    const path=`/api/projects/${project}/solo-test-sets/${pub.testSet.id}/versions/${pub.version.id}`;
    await measured('100MB-first-export',users,1,()=>interference(users,1,()=>req(sessions[0],'GET',path+'/data.csv')));
    await measured('100MB-cached-export',users,2,()=>interference(users,2,()=>req(sessions[0],'GET',path+'/data.csv')));
  }
  for(let run=1;run<=3;run++) {
    const ids=await Promise.all([draft('双发布A-'+run),draft('双发布B-'+run)]);
    await measured('double-10000-publish',3,run,async()=>{
      let done=false;const observations:number[]=[];let readerError:Error|undefined;
      const reader=(async()=>{while(!done){const at=performance.now();await req(sessions[2],'GET',publishedPaths[0]+'/records?limit=20');observations.push(performance.now()-at);await delay(250);}})().catch(error=>{readerError=error;done=true;});
      try {await Promise.all(ids.map((id,index)=>publish(sessions[index],id)));}
      finally {done=true;await reader;samples.push({stage:'double-publish-interference',users:3,run,observations});if(readerError)throw readerError;}
    });
  }
  }
  await writeFile(dir+`/bench-csv-hashes-${variant}.json`,JSON.stringify(csvHashes));
}catch(cause){error=(cause as Error).message;process.exitCode=1;}
finally {
  clearInterval(memory);await writeFile(dir+`/bench-${variant}.json`,JSON.stringify({variant,normalOnly,source:root,started:starts,finished:new Date().toISOString(),schema,samples,error},null,2));
  await app.close();await db.end();await adminDb.end();
}
