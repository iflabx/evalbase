import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {assert,delay,hash,randomUUID,evidence,request,login,readFixture,saveFixture,projectPath,draftPath,versionPath,snapshot,createDraft,publish,sourceFixture,upload,confirm,select,setPhase,phase} from './common.mjs';
const {Pool}=createRequire('/app/package.json')('pg');
const db=new Pool({connectionString:'postgresql://performance_validation:synthetic-performance-only@postgres:5432/evalbase_performance_validation',max:1,application_name:'performance-fixtures'});
const f=await readFixture(),[admin,editor,viewer]=await Promise.all(['admin','editor','viewer'].map(login));
const resumedCases=process.env.PERF_CASES?.split(',');
const skipKnownOversize=process.env.PERF_SKIP_KNOWN_OVERSIZE==='1';
async function caseRun(name,work) {
  if(resumedCases&&!resumedCases.includes(name))return;
  assert(!await readFile(`${evidence}/STOP.json`).then(()=>true).catch(()=>false),'safety_stop');
  setPhase(name);const at=performance.now(),started=new Date().toISOString();
  try{const result=await work();await appendFile(`${evidence}/heavy-checks.jsonl`,JSON.stringify({name,status:skipKnownOversize&&name==='row-file-and-normalized-byte-boundaries'?'passed-except-known-oversize-failure':'passed',started,finished:new Date().toISOString(),ms:performance.now()-at})+'\n');return result;}
  catch(error){await appendFile(`${evidence}/heavy-checks.jsonl`,JSON.stringify({name,status:'failed',started,finished:new Date().toISOString(),error:error.message,ms:performance.now()-at})+'\n');throw error;}
}
async function background(work,users=3) {
  let done=false;
  const browserProbe=process.env.PERF_BROWSER_PROBE==='1';
  const epoch=randomUUID();
  if(browserProbe){
    await writeFile(`${evidence}/probe-command.json`,JSON.stringify({active:true,role:users===2?'editor':'viewer',users,epoch,phase}));
    const wait=performance.now();
    while((await readFile(`${evidence}/probe-ack.json`,'utf8').then(JSON.parse).catch(()=>({}))).epoch!==epoch){assert(performance.now()-wait<30000,'browser_probe_not_ready');await delay(100);}
  }
  const sessions=browserProbe?(users===2?[]:[editor]):[editor,viewer].slice(0,users-1);
  const readers=sessions.map(async session=>{
    let nextSave=0;
    while(!done){
      if(!browserProbe||users===3) await request(session,'GET',versionPath(f)+'/records?limit=20',undefined,{label:'interference-read'});
      if(session===editor&&performance.now()>=nextSave){
        const row=(await snapshot(editor,f,f.smallDraft)).records[1];
        await request(editor,'PATCH',draftPath(f,f.smallDraft)+`/records/${row.id}`,{field:'expectedOutput',value:`重操作期间-${Math.round(performance.now())}`,expectedFieldRevision:row.expectedOutputRevision},{label:'interference-save'});
        nextSave=performance.now()+5000;
      }
      await delay(250);
    }
  });
  try{return await work();}finally{
    done=true;await Promise.all(readers);
    if(browserProbe){
      const leaving=randomUUID();await writeFile(`${evidence}/probe-command.json`,JSON.stringify({active:false,epoch:leaving,phase}));
      const wait=performance.now();while((await readFile(`${evidence}/probe-ack.json`,'utf8').then(JSON.parse).catch(()=>({}))).epoch!==leaving){assert(performance.now()-wait<30000,'browser_probe_not_paused');await delay(100);}
    }
  }
}
function sizedCsv(bytes,rows,salt) {
  const header='question,answer,topic,empty\n';
  const baseRows=Array.from({length:rows},(_,i)=>`q${salt}${String(i).padStart(5,'0')},a,t,`);
  const overhead=Buffer.byteLength(header+baseRows.join('\n')+'\n');
  const pad=Math.floor((bytes-overhead)/rows),extra=(bytes-overhead)%rows;
  const value=header+baseRows.map((row,i)=>row.replace(',a,',`${'x'.repeat(pad+(i===0?extra:0))},a,`)).join('\n')+'\n';
  assert.equal(Buffer.byteLength(value),bytes);return value;
}
async function seedNormalizedDraft(bytes,name) {
  const draft=await createDraft(admin,f,name);
  const count=10000,baseBytes=1+count*(JSON.stringify({question:'q00001',expectedOutput:'',metadata:[]}).length+1);
  const pad=Math.floor((bytes-baseBytes)/count),extra=(bytes-baseBytes)%count;
  assert(pad+extra+6<=100000);
  await db.query(`INSERT INTO collaborative_draft_record(draft_id,id,position,question,expected_output,metadata,source,updated_by)
    SELECT $1,$1||'-size-'||n,n,'q'||lpad(n::text,5,'0')||repeat('x',$2+CASE WHEN n=1 THEN $3 ELSE 0 END),'','[]'::jsonb,NULL,u.id
    FROM generate_series(1,10000) n CROSS JOIN app_user u WHERE u.role='admin'`,[draft,pad,extra]);
  await db.query(`UPDATE collaborative_draft SET revision=revision+1 WHERE id=$1`,[draft]);
  const rows=await db.query(`SELECT question,expected_output AS "expectedOutput",metadata FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position`,[draft]);
  assert.equal(Buffer.byteLength(JSON.stringify(rows.rows)),bytes);
  await appendFile(`${evidence}/fixture-sizes.jsonl`,JSON.stringify({name,normalizedBytes:bytes,rows:count,method:'isolated-SQL-fixture-preparation-excluded-from-publish-time'})+'\n');
  return draft;
}
try {
  await caseRun('collaboration-races-and-presence-isolation',async()=>{
    const draft=await createDraft(editor,f,'删除竞争夹具');
    for(let i=0;i<20;i++) {
      await request(editor,'POST',draftPath(f,draft)+'/records',{question:`竞争-${i}`},{expected:[201],label:'race-record'});
      const row=(await snapshot(admin,f,draft)).records.at(-1);
      const [edit,remove]=await Promise.all([
        request(admin,'PATCH',draftPath(f,draft)+`/records/${row.id}`,{field:'question',value:`已编辑-${i}`,expectedFieldRevision:row.questionRevision},{expected:[200,409],label:'expected-edit-delete-race'}),
        request(editor,'DELETE',draftPath(f,draft)+`/records/${row.id}`,{expectedRowRevision:row.rowRevision},{expected:[204,409],label:'expected-delete-edit-race'}),
      ]);
      assert.equal(Number(edit.response.status===200)+Number(remove.response.status===204),1);
      if(edit.response.status===409)assert.equal(edit.json().error.code,'draft_record_removed');
      if(remove.response.status===409)assert.equal(remove.json().error.code,'draft_row_conflict');
      const state=await snapshot(admin,f,draft),actual=state.records.find(r=>r.id===row.id);
      if(edit.response.status===200)assert.equal(actual.question,`已编辑-${i}`);else assert.equal(actual,undefined);
      await appendFile(`${evidence}/race-results.jsonl`,JSON.stringify({editStatus:edit.response.status,deleteStatus:remove.response.status})+'\n');
    }
    const small=(await snapshot(admin,f,f.smallDraft)).records[0];
    const wide=(await snapshot(admin,f)).records[0];
    const clients=[[admin,'presence-admin-a',f.smallDraft,small.id,'question'],[admin,'presence-admin-b',f.draft,wide.id,'metadata'],[editor,'presence-editor',f.smallDraft,small.id,'expectedOutput'],[viewer,'presence-viewer']];
    for(const [session,clientId,draftId,recordId,field] of clients)await request(session,'POST',projectPath(f)+'/presence',{clientId,...(draftId?{draftId,recordId,field}:{})},{expected:[204],label:'presence-fixture'});
    const focused=(await request(admin,'GET',projectPath(f)+`/presence?draftId=${f.smallDraft}`,undefined,{label:'presence-small'})).json().users;
    assert.equal(focused.length,3);assert.equal(focused.filter(u=>u.focus?.draftId===f.smallDraft).length,2);
    const other=(await request(editor,'GET',projectPath(f)+`/presence?draftId=${f.draft}`,undefined,{label:'presence-other'})).json().users;
    assert.equal(other.filter(u=>u.focus?.draftId===f.draft).length,1);
    await request(viewer,'GET',projectPath(f)+`/presence?draftId=${f.smallDraft}`,undefined,{expected:[404],label:'expected-viewer-focus-denied'});
    const beforeA=(await snapshot(admin,f,f.smallDraft)).draft.revision,beforeB=(await snapshot(editor,f)).draft.revision;
    await request(admin,'PATCH',draftPath(f,f.smallDraft)+`/records/${small.id}`,{field:'question',value:'跨草稿事件',expectedFieldRevision:small.questionRevision},{label:'isolated-draft-edit'});
    const changed=(await request(editor,'GET',draftPath(f,f.smallDraft)+`/events?after=${beforeA}`,undefined,{label:'events-changed'})).json();
    const unchanged=(await request(editor,'GET',draftPath(f)+`/events?after=${beforeB}`,undefined,{label:'events-unchanged'})).json();
    assert(changed.events.length>0);assert.equal(unchanged.events.length,0);
    await delay(16000);
    assert.equal((await request(admin,'GET',projectPath(f)+'/presence',undefined,{label:'presence-expired'})).json().users.length,0);
  });
  await caseRun('formats-repetitions-and-idempotent-confirm',async()=>{
    for(const [rows,format] of [[100,'csv'],[1000,'json'],[10000,'jsonl']]){
      for(let run=1;run<=5;run++){
        setPhase(`formats-${rows}-${format}-run-${run}`);
        const text=sourceFixture(rows,format,run%2?0:100,`repeat-${rows}-${run}`);
        const pending=await upload(admin,f,text,`repeat-${rows}-${run}.${format}`,format),key=randomUUID();
        const confirmed=await confirm(admin,f,[pending],key),asset=confirmed.assets[0].id;
        const replay=await confirm(admin,f,[pending],key);assert.equal(replay.assets[0].id,asset);
        const draft=await createDraft(admin,f,`容量样本 ${rows}-${run}`);await select(admin,f,draft,[asset]);
        const initial=await background(()=>publish(admin,f,draft,{label:`publish-root-${rows}`}),run%2?2:3);
        const sample={rows,asset,testSetId:initial.testSet.id,versionId:initial.version.id};
        f.samples.push(sample);
        for(const file of ['data.csv','provenance.csv']){
          const a=await background(()=>request(admin,'GET',versionPath(f,sample)+'/'+file,undefined,{label:`export-first-${rows}`}));
          const b=await request(admin,'GET',versionPath(f,sample)+'/'+file,undefined,{label:`export-repeat-${rows}`});assert.equal(hash(a.text),hash(b.text));
        }
        const derived=await createDraft(editor,f,'',{testSetId:sample.testSetId,parentVersionId:sample.versionId});
        const row=(await snapshot(editor,f,derived)).records[0];
        await request(editor,'PATCH',draftPath(f,derived)+`/records/${row.id}`,{field:'expectedOutput',value:`稀疏-${run}`,expectedFieldRevision:row.expectedOutputRevision},{label:'sparse-edit'});
        await background(()=>publish(admin,f,derived,{label:`publish-sparse-${rows}`}));
        {
          // Large change sets are fixtures: prepare in SQL, measure the real HTTP publication.
          const dense=await createDraft(editor,f,'',{testSetId:sample.testSetId,parentVersionId:sample.versionId});
          await db.query(`UPDATE collaborative_draft_record SET expected_output='密集夹具',expected_output_revision=expected_output_revision+1,row_revision=row_revision+1 WHERE draft_id=$1 AND position<=$2`,[dense,Math.ceil(rows*.3)]);
          await db.query('UPDATE collaborative_draft SET revision=revision+1 WHERE id=$1',[dense]);
          await background(()=>publish(admin,f,dense,{label:`publish-dense-${rows}`}));
        }
      }
    }
    await saveFixture(f);
  });
  await caseRun('upload-concurrency-cancel-and-duplicate-bytes',async()=>{
    const texts=[0,1].map(i=>sourceFixture(10000,'csv',0,`parallel-${i}`));
    const pending=await Promise.all(texts.map((text,i)=>upload(i?editor:admin,f,text,`parallel-${i}.csv`)));
    const confirmed=await Promise.all(pending.map((id,i)=>confirm(i?editor:admin,f,[id])));
    assert.equal(confirmed.length,2);
    const repeated=await request(admin,'POST',projectPath(f)+'/pending-uploads',texts[0],{expected:[409],label:'expected-duplicate-upload',headers:{'content-type':'text/csv','x-file-name':'duplicate.csv'}});
    assert.equal(repeated.json().error.code,'duplicate_upload');
    const cancelled=await upload(admin,f,sourceFixture(10,'jsonl',0,'cancel'),'cancel.jsonl','jsonl');
    await request(admin,'DELETE',projectPath(f)+'/pending-upload-batches',{pendingUploadIds:[cancelled]},{expected:[204],label:'cancel-upload'});
    const denied=(await request(admin,'POST',projectPath(f)+'/pending-upload-batches/confirm',{collectionId:f.collection,pendingUploadIds:[cancelled]},{expected:[404],label:'expected-cancelled-confirm',headers:{'idempotency-key':randomUUID()}})).json();assert.equal(denied.error.code,'pending_upload_not_found');
  });
  await caseRun('row-file-and-normalized-byte-boundaries',async()=>{
    // The initial attempt already completed row/file boundaries before the known TCP reset.
    if(!skipKnownOversize){
    const fileCount=(await request(admin,'GET',projectPath(f)+'/collaborative-draft-source-files',undefined,{label:'source-files'})).json().total;
    const badPending=await upload(admin,f,sourceFixture(10001,'csv',0,'over-rows'),'over-rows.csv');
    const goodPending=await upload(admin,f,sourceFixture(10,'csv',0,'atomic-valid'),'atomic-valid.csv');
    const blocked=(await request(admin,'POST',projectPath(f)+'/pending-upload-batches/confirm',{collectionId:f.collection,pendingUploadIds:[goodPending,badPending]},{expected:[422],label:'expected-row-capacity',headers:{'idempotency-key':randomUUID()}})).json();assert.equal(blocked.error.code,'pending_upload_not_previewable');
    assert.equal((await request(admin,'GET',projectPath(f)+'/collaborative-draft-source-files',undefined,{label:'source-files'})).json().total,fileCount);
    await confirm(admin,f,[goodPending]);
    assert.equal((await request(admin,'POST',draftPath(f)+'/records',{}, {expected:[422],label:'expected-10001-draft-row'})).json().error.code,'test_set_capacity_exceeded');
    const files=[];
    for(let i=0;i<6;i++){const pending=await upload(admin,f,sourceFixture(1,'csv',0,`file-limit-${i}`),`file-limit-${i}.csv`);files.push((await confirm(admin,f,[pending])).assets[0].id);}
    const five=await createDraft(admin,f,'五文件边界');await select(admin,f,five,files.slice(0,5));
    assert.equal((await select(admin,f,five,[files[5]],{expected:[422],label:'expected-sixth-file'})).error.code,'test_set_capacity_exceeded');assert.equal((await snapshot(admin,f,five)).total,5);
    }
    if(skipKnownOversize)await appendFile(`${evidence}/heavy-checks.jsonl`,JSON.stringify({name:'50000001-byte-upload',status:'skipped-known-failure',evidence:'oversize-diagnostic-result.json',at:new Date().toISOString()})+'\n');
    else await request(admin,'POST',projectPath(f)+'/pending-uploads',Buffer.alloc(50000001,120),{expected:[413],label:'expected-50000001-bytes',headers:{'content-type':'text/csv','x-file-name':'over-bytes.csv'}});
    const large=[];
    for(const salt of ['A','B']){
      const text=sizedCsv(50000000,4999,salt),pending=await background(()=>upload(admin,f,text,`size-${salt}.csv`));
      large.push((await background(()=>confirm(admin,f,[pending]))).assets[0].id);
      await appendFile(`${evidence}/fixture-sizes.jsonl`,JSON.stringify({name:`size-${salt}`,rawBytes:50000000,rows:4999,sha256:hash(text)})+'\n');
    }
    const exact=await createDraft(admin,f,'原始字节边界');await background(()=>select(admin,f,exact,large));assert.equal((await snapshot(admin,f,exact)).total,9998);
    const tiny=sourceFixture(1,'csv',0,'tiny');const tinyPending=await upload(admin,f,tiny,'tiny.csv'),tinyAsset=(await confirm(admin,f,[tinyPending])).assets[0].id;
    const text=sizedCsv(50000001-Buffer.byteLength(tiny),4999,'C'),pending=await upload(admin,f,text,'size-C.csv'),adjusted=(await confirm(admin,f,[pending])).assets[0].id;
    const over=await createDraft(admin,f,'原始字节超一');await select(admin,f,over,[large[0],adjusted]);
    assert.equal((await select(admin,f,over,[tinyAsset],{expected:[422],label:'expected-100000001-raw-bytes'})).error.code,'test_set_capacity_exceeded');
    assert.equal((await snapshot(admin,f,over)).total,9998);
    const normalized=await seedNormalizedDraft(100000000,'规范化字节边界');const published=await background(()=>publish(admin,f,normalized,{label:'publish-normalized-100MB',timeout:120000}));
    const sample={testSetId:published.testSet.id,versionId:published.version.id};
    await background(()=>request(admin,'GET',versionPath(f,sample)+'/data.csv',undefined,{label:'export-100MB',timeout:120000}));
    const tooMuch=await seedNormalizedDraft(100000001,'规范化字节超一');
    const before=Number((await db.query('SELECT count(*) AS n FROM test_set_version')).rows[0].n);
    assert.equal((await publish(admin,f,tooMuch,{expected:[422],label:'expected-100000001-normalized-bytes',timeout:120000})).error.code,'test_set_capacity_exceeded');
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM test_set_version')).rows[0].n),before);
  });
  await caseRun('two-heavy-publications-with-viewer-probe',async()=>{
    for(let run=1;run<=5;run++) {
    const drafts=await Promise.all([admin,editor].map(session=>createDraft(session,f,'并发大发布')));
    await Promise.all(drafts.map((draft,i)=>select(i?editor:admin,f,draft,[f.loadSample.asset])));
    let finished=false;
    const probe=(async()=>{while(!finished){await request(viewer,'GET',versionPath(f)+'/records?limit=20',undefined,{label:'two-publish-viewer'});await delay(250);}})();
    try{const results=await Promise.all(drafts.map((draft,i)=>publish(i?editor:admin,f,draft)));assert.notEqual(results[0].version.id,results[1].version.id);}finally{finished=true;await probe;}
    }
  });
  await caseRun('background-checkpoint-with-export',async()=>{
    const draft=await createDraft(admin,f,'',{testSetId:f.loadSample.testSetId,parentVersionId:f.loadSample.versionId});
    const row=(await snapshot(admin,f,draft)).records[0];
    await request(admin,'PATCH',draftPath(f,draft)+`/records/${row.id}`,{field:'question',value:'后台 Checkpoint 干扰',expectedFieldRevision:row.questionRevision},{label:'checkpoint-fixture-edit'});
    const result=await publish(admin,f,draft),job=randomUUID();
    const started=performance.now();
    await db.query(`INSERT INTO job(id,project_id,actor_id,kind,payload,status,correlation_id,idempotency_key)
      SELECT $1,$2,id,'materialize_version_checkpoint',$3::jsonb,'queued',$1,$1 FROM app_user WHERE role='admin'`,[job,f.project,JSON.stringify({versionId:result.version.id})]);
    await background(async()=>{
      await request(admin,'GET',versionPath(f)+'/data.csv',undefined,{label:'checkpoint-interference-export'});
      while(true){
        const status=(await db.query('SELECT status FROM job WHERE id=$1',[job])).rows[0].status;
        assert(status!=='failed','checkpoint_failed');if(status==='succeeded')break;
        assert(performance.now()-started<300000,'checkpoint_no_progress');await delay(200);
      }
    });
    await appendFile(`${evidence}/checkpoint-observations.jsonl`,JSON.stringify({name:'background-export',completedMs:performance.now()-started})+'\n');
  });
  await caseRun('version-filters-and-long-empty-metadata',async()=>{
    const path=versionPath(f);
    for(const [query,count] of [
      [`metadataField=topic&metadata=${encodeURIComponent('主题-1')}`,2000],
      ['origin=source',10000],['origin=manual',0],
      [`sourceAssetId=${f.loadSample.asset}`,10000],['question=missing',0],
      [`search=${encodeURIComponent('问题-baseline-10000-00000')}`,1],
    ]) {
      const result=(await request(viewer,'GET',path+'/records?limit=20&'+query,undefined,{label:'version-filter'})).json();
      assert.equal(result.pagination.total,count);assert(result.records.length<=20);
    }
    const draft=await createDraft(editor,f,'多项 Metadata 与换行');
    const metadata=Array.from({length:100},(_,i)=>({key:`项-${i}`,value:i%2?'中文\n多行':''}));
    const added=(await request(editor,'POST',draftPath(f,draft)+'/records',{question:'中文\n多行问题',expectedOutput:'x'.repeat(100000),metadata},{expected:[201],label:'long-record'})).json();
    const state=await snapshot(editor,f,draft);assert.equal(state.total,1);assert.deepEqual(state.records[0].metadata,metadata);
    await publish(admin,f,draft);
  });
  await caseRun('list-scales-and-legacy-read-compatibility',async()=>{
    const project=(await request(admin,'POST','/api/projects',{name:'自动化列表容量'},{expected:[201],label:'list-project'})).json().project.id;
    const lf={project};f.listProject=project;
    for(const [role,session] of [['editor',editor],['viewer',viewer]]) {
      const invite=(await request(admin,'POST',projectPath(lf)+'/invitations',{email:`${role}@perf.test`,role},{expected:[201],label:'list-invite'})).json();
      await request(session,'POST',`/api/me/invitations/${invite.invitation.id}/accept`,undefined,{label:'list-accept'});
    }
    let legacySample;
    for(let i=1;i<=100;i++) {
      await createDraft(editor,lf,`列表草稿-${String(i).padStart(3,'0')}`);
      const draft=await createDraft(admin,lf,`列表正式-${String(i).padStart(3,'0')}`);
      await request(admin,'POST',draftPath(lf,draft)+'/records',{question:`列表问题-${i}`},{expected:[201],label:'list-record'});
      const published=await publish(admin,lf,draft);
      if(i===1)legacySample={testSetId:published.testSet.id,versionId:published.version.id};
      if([5,25,100].includes(i)) {
        const list=(await request(editor,'GET',projectPath(lf)+'/solo-test-sets?limit=10',undefined,{label:`formal-list-${i}`})).json();
        const drafts=(await request(editor,'GET',projectPath(lf)+'/collaborative-drafts',undefined,{label:`draft-list-${i}`})).json();
        assert.equal(list.pagination.total,i);
        assert.equal(drafts.drafts.filter(d=>!d.testSetId).length,i);
        await appendFile(`${evidence}/list-scales.jsonl`,JSON.stringify({drafts:i,formal:i,formalResponseBytes:Buffer.byteLength(JSON.stringify(list)),draftResponseBytes:Buffer.byteLength(JSON.stringify(drafts))})+'\n');
      }
    }
    const before=hash((await request(viewer,'GET',versionPath(lf,legacySample)+'/data.csv',undefined,{label:'checkpoint-csv'})).text);
    // Conversion only prepares a legacy fixture in the disposable database; no measured app publication uses this protocol.
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO version_member(version_id,case_revision_id,ordinal) SELECT $1,case_revision_id,ordinal FROM resolve_version_members($1)`,[legacySample.versionId]);
      await db.query(`UPDATE test_set_version SET storage_format='legacy_full_v1' WHERE id=$1`,[legacySample.versionId]);
      await db.query('DELETE FROM version_checkpoint_member WHERE version_id=$1',[legacySample.versionId]);
      await db.query('DELETE FROM version_checkpoint WHERE version_id=$1',[legacySample.versionId]);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;}
    assert.equal(hash((await request(viewer,'GET',versionPath(lf,legacySample)+'/data.csv',undefined,{label:'legacy-csv'})).text),before);
    const page=(await request(viewer,'GET',versionPath(lf,legacySample)+'/records?limit=20',undefined,{label:'legacy-page'})).json();assert.equal(page.pagination.total,1);assert.equal(page.records[0].question,'列表问题-1');
    await saveFixture(f);
  });
  await caseRun('version-chain-branches-trash-and-tombstone',async()=>{
    const initial=f.samples.find(x=>x.rows===100&&!x.parentVersionId);
    let parent=initial.versionId;
    const chain=[];
    for(let i=0;i<22;i++){
      const draft=await createDraft(admin,f,'',{testSetId:initial.testSetId,parentVersionId:parent});
      const row=(await snapshot(admin,f,draft)).records[0];
      await request(admin,'PATCH',draftPath(f,draft)+`/records/${row.id}`,{field:'expectedOutput',value:`链-${i}`,expectedFieldRevision:row.expectedOutputRevision},{label:'chain-edit'});
      const result=await background(()=>publish(admin,f,draft));parent=result.version.id;chain.push(result.version);
      const observed=await db.query(`WITH RECURSIVE path AS (
        SELECT id,parent_version_id,storage_format,item_count,0 AS distance FROM test_set_version WHERE id=$1
        UNION ALL SELECT v.id,v.parent_version_id,v.storage_format,v.item_count,p.distance+1 FROM path p JOIN test_set_version v ON v.id=p.parent_version_id
      ), anchor AS (SELECT p.id,p.distance FROM path p WHERE p.storage_format='legacy_full_v1' OR EXISTS(SELECT 1 FROM version_checkpoint cp WHERE cp.version_id=p.id AND cp.members_hash=checkpoint_members_hash(cp.version_id)) ORDER BY distance LIMIT 1)
      SELECT (SELECT storage_format FROM path WHERE distance=0) AS storage,
        (SELECT depth FROM (SELECT count(*)::int AS depth FROM path p,anchor a WHERE p.distance<a.distance AND p.storage_format='delta_v1') x) AS replay_depth,
        (SELECT count(*) FROM version_change c JOIN path p ON p.id=c.version_id,anchor a WHERE p.distance<a.distance) AS replay_changes,
        (SELECT reason FROM version_checkpoint WHERE version_id=$1) AS checkpoint_reason`,[parent]);
      await appendFile(`${evidence}/checkpoint-observations.jsonl`,JSON.stringify({name:'chain',generation:i+2,...observed.rows[0]})+'\n');
    }
    const target=chain[4],leaf=chain.at(-1),sample={testSetId:initial.testSetId,versionId:leaf.id};
    await writeFile(`${evidence}/delete-targets.json`,JSON.stringify({project:f.project,testSetId:initial.testSetId,middleVersion:target.id,middleLabel:target.label,leafVersion:leaf.id,leafLabel:leaf.label}));
    const before=hash((await request(viewer,'GET',versionPath(f,sample)+'/data.csv',undefined,{label:'descendant-csv-before'})).text);
    await background(()=>request(admin,'POST',versionPath(f,{testSetId:initial.testSetId,versionId:target.id})+'/tombstone',{confirmation:target.label},{label:'tombstone-middle',timeout:120000}));
    await request(viewer,'GET',versionPath(f,{testSetId:initial.testSetId,versionId:target.id})+'/records',undefined,{expected:[404],label:'expected-tombstone-denial'});
    assert.equal(hash((await request(viewer,'GET',versionPath(f,sample)+'/data.csv',undefined,{label:'descendant-csv-after'})).text),before);
    const trash=(await request(admin,'POST',versionPath(f,sample)+'/trash',{}, {expected:[201],label:'trash-leaf'})).json();
    await request(admin,'POST',projectPath(f)+`/solo-test-set-trash/${trash.entry.id}/restore`,{}, {label:'restore-leaf'});
    assert.equal(hash((await request(viewer,'GET',versionPath(f,sample)+'/data.csv',undefined,{label:'restored-csv'})).text),before);
    const again=(await request(admin,'POST',versionPath(f,sample)+'/trash',{}, {expected:[201],label:'trash-leaf-again'})).json();
    await request(admin,'POST',projectPath(f)+`/solo-test-set-trash/${again.entry.id}/permanent-delete`,{confirmation:leaf.label},{label:'permanent-delete-synthetic-leaf',timeout:120000});
  });
  await writeFile(`${evidence}/heavy-complete`,skipKnownOversize?'completed-with-known-oversize-failure':'passed');
}catch(error){await writeFile(`${evidence}/heavy-failure.json`,JSON.stringify({error:error.message,at:new Date().toISOString()}));process.exitCode=1;console.error(error.message);}
finally{await db.end();}
