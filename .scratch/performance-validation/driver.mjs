import {appendFile, writeFile} from 'node:fs/promises';
import {assert, randomUUID, delay, evidence, request, login, readFixture, saveFixture, projectPath, draftPath, versionPath, snapshot, createDraft, publish, sourceFixture, upload, confirm, select, setPhase, hash} from './common.mjs';

const mode = process.argv[2];
const check = async (name, work) => {
  const at=performance.now();
  try { const value=await work(); await appendFile(`${evidence}/checks.jsonl`,JSON.stringify({name,status:'passed',ms:performance.now()-at})+'\n'); return value; }
  catch(error) { await appendFile(`${evidence}/checks.jsonl`,JSON.stringify({name,status:'failed',error:error.message,ms:performance.now()-at})+'\n'); throw error; }
};
async function setup() {
  const password=process.env.PERF_PASSWORD;
  const ready=(await request(null,'GET','/health/ready',undefined,{label:'health'})).json();
  assert.equal(ready.git_sha,'1d622405f19f19300203ba82a08f80966b3573e3');
  await request(null,'POST','/api/installation/administrator',{email:'admin@perf.test',displayName:'管理员',password,confirmPassword:password},{expected:[201],label:'register-admin'});
  for(const role of ['editor','viewer']) await request(null,'POST','/api/accounts',{email:`${role}@perf.test`,password,confirmPassword:password},{expected:[201],label:'register-account'});
  const [admin,editor,viewer]=await Promise.all(['admin','editor','viewer'].map(login));
  const project=(await request(admin,'POST','/api/projects',{name:'性能测试合成项目'},{expected:[201],label:'create-project'})).json().project.id;
  const f={project,samples:[],fixtureManifest:[],builtSha:ready.git_sha};
  for(const [role,session] of [['editor',editor],['viewer',viewer]]) {
    const invite=(await request(admin,'POST',`${projectPath(f)}/invitations`,{email:`${role}@perf.test`,role},{expected:[201],label:'invite'})).json();
    await request(session,'POST',`/api/me/invitations/${invite.invitation.id}/accept`,undefined,{label:'accept-invite'});
  }
  f.collection=(await request(admin,'GET',`${projectPath(f)}/collections`,undefined,{label:'collections'})).json().collections[0].id;
  const text=sourceFixture(100);
  const pending=await upload(admin,f,text,'baseline.csv');
  const asset=(await confirm(admin,f,[pending])).assets[0].id;
  f.fixtureManifest.push({format:'csv',rows:100,rawBytes:Buffer.byteLength(text),sha256:hash(text),asset});
  const root=await createDraft(admin,f,'性能基线');
  await select(admin,f,root,[asset]);
  const published=await publish(admin,f,root);
  f.samples.push({rows:100,asset,testSetId:published.testSet.id,versionId:published.version.id});
  f.draft=await createDraft(editor,f,'',{testSetId:published.testSet.id,parentVersionId:published.version.id});
  f.smallDraft=await createDraft(admin,f,'小草稿');
  for(let i=0;i<3;i++) await request(admin,'POST',draftPath(f,f.smallDraft)+'/records',{}, {expected:[201],label:'add-record'});
  await saveFixture(f);
  await writeFile(`${evidence}/status.json`,JSON.stringify({phase:'setup-complete',at:new Date().toISOString()}));
}
async function correctness() {
  const f=await readFixture();
  const [admin,editor,viewer]=await Promise.all(['admin','editor','viewer'].map(login));
  setPhase('preflight');
  await check('viewer-cannot-read-or-edit-draft',async()=>{
    await request(viewer,'GET',draftPath(f),undefined,{expected:[404],label:'expected-draft-denial'});
    await request(viewer,'POST',`${projectPath(f)}/collaborative-drafts`,{}, {expected:[404],label:'expected-create-denial'});
    await request(viewer,'GET',versionPath(f)+'/records?limit=20',undefined,{label:'viewer-formal-page'});
  });
  let state=await snapshot(admin,f), row=state.records[0];
  await check('different-fields-save-without-loss',async()=>{
    await Promise.all([
      request(admin,'PATCH',draftPath(f)+`/records/${row.id}`,{field:'question',value:'并发问题',expectedFieldRevision:row.questionRevision},{label:'save-question'}),
      request(editor,'PATCH',draftPath(f)+`/records/${row.id}`,{field:'expectedOutput',value:'并发期望',expectedFieldRevision:row.expectedOutputRevision},{label:'save-output'}),
    ]);
    row=(await snapshot(admin,f)).records[0]; assert.equal(row.question,'并发问题'); assert.equal(row.expectedOutput,'并发期望');
  });
  await check('same-field-and-metadata-CAS-conflicts',async()=>{
    for(const [field,value] of [['question','先保存'],['metadata',[{key:'备注',value:''}]]]) {
      row=(await snapshot(admin,f)).records[0];
      const rev=row[field+'Revision'];
      await request(admin,'PATCH',draftPath(f)+`/records/${row.id}`,{field,value,expectedFieldRevision:rev},{label:'save-field'});
      const rejected=(await request(editor,'PATCH',draftPath(f)+`/records/${row.id}`,{field,value:field==='metadata'?[{key:'另一个',value:''}]:'迟到输入',expectedFieldRevision:rev},{expected:[409],label:'expected-field-conflict'})).json();
      assert.equal(rejected.error.code,'draft_field_conflict');
      const actual=(await snapshot(admin,f)).records[0]; assert.deepEqual(actual[field],value);
    }
  });
  await check('unique-publish-and-parent-immutability',async()=>{
    const before=hash((await request(viewer,'GET',versionPath(f)+'/data.csv',undefined,{label:'csv-before'})).text);
    const state=await snapshot(admin,f);
    const results=await Promise.all([admin,editor].map(session=>request(session,'POST',draftPath(f)+'/publish',{revision:state.draft.revision},{expected:[200,201],label:'concurrent-publish'})));
    const a=results[0].json(),b=results[1].json(); assert.equal(a.version.id,b.version.id);
    const after=hash((await request(viewer,'GET',versionPath(f)+'/data.csv',undefined,{label:'csv-after'})).text); assert.equal(after,before);
    f.samples.push({...f.samples[0],versionId:a.version.id,parentVersionId:f.samples[0].versionId});
    f.draft=await createDraft(admin,f,'',{testSetId:a.testSet.id,parentVersionId:a.version.id});
    await saveFixture(f);
  });
}
let seed=9324;
function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;}
async function baseline() {
  const f=await readFixture(),admin=await login('admin');
  setPhase('baseline-fixtures');
  for(const [rows,format] of [[1000,'json'],[10000,'jsonl']]) {
    const text=sourceFixture(rows,format,0,`baseline-${rows}`);
    const pending=await upload(admin,f,text,`baseline-${rows}.${format}`,format);
    const asset=(await confirm(admin,f,[pending])).assets[0].id;
    const draft=await createDraft(admin,f,`性能基线 ${rows}`);
    await select(admin,f,draft,[asset]);
    const result=await publish(admin,f,draft);
    const sample={rows,asset,testSetId:result.testSet.id,versionId:result.version.id};
    f.samples.push(sample);
    f.fixtureManifest.push({rows,format,rawBytes:Buffer.byteLength(text),sha256:hash(text),asset});
    if(rows===10000){f.loadSample=sample;f.draft=await createDraft(admin,f,'',{testSetId:sample.testSetId,parentVersionId:sample.versionId});}
    await saveFixture(f);
  }
  for(let repeat=1;repeat<=3;repeat++) {
    setPhase(`single-baseline-${repeat}`);
    for(const sample of f.samples.filter(x=>[100,1000,10000].includes(x.rows)&&!x.parentVersionId)) {
      for(let i=0;i<40;i++) {
        await request(admin,'GET',versionPath(f,sample)+`/records?limit=20&offset=${(i%5)*20}`,undefined,{label:`page-${sample.rows}`});
        await request(admin,'GET',versionPath(f,sample)+'/records?limit=20&search='+encodeURIComponent('问题'),undefined,{label:`search-${sample.rows}`});
      }
      for(const csv of ['data.csv','provenance.csv']) {
        const first=(await request(admin,'GET',versionPath(f,sample)+'/'+csv,undefined,{label:`${csv}-first-${sample.rows}`})).text;
        const second=(await request(admin,'GET',versionPath(f,sample)+'/'+csv,undefined,{label:`${csv}-repeat-${sample.rows}`})).text;
        assert.equal(hash(first),hash(second));
      }
      const empty=(await request(admin,'GET',versionPath(f,sample)+'/records?limit=20&search=NO_MATCH_UNIQUE',undefined,{label:'empty-search'})).json();
      assert.equal(empty.pagination.total,0);
    }
  }
  await writeFile(`${evidence}/baseline-complete`,'passed');
}
async function load(users,runNumber) {
  const f=await readFixture();
  const sessions=await Promise.all(['admin','editor','viewer'].slice(0,users).map(login));
  const warmupMs=Number(process.env.PERF_WARMUP_MS??120000), durationMs=Number(process.env.PERF_DURATION_MS??1200000);
  const started=performance.now(), end=started+warmupMs+durationMs;
  const status=()=>writeFile(`${evidence}/status.json`,JSON.stringify({phase:'mixed-load',users,run:runNumber,elapsedSeconds:Math.round((performance.now()-started)/1000),warmupSeconds:warmupMs/1000,measureSeconds:durationMs/1000,at:new Date().toISOString()}));
  let stop=false;
  const ticker=setInterval(()=>status().catch(()=>{}),10000);
  const work=sessions.map(async(session,index)=>{
    let nextHeartbeat=0,nextEvent=0,cursor=0,nextSave=performance.now()+5000;
    const clientId=`load-${users}-${runNumber}-${index}`;
    while(performance.now()<end&&!stop) {
      setPhase(performance.now()-started<warmupMs?'warmup':`mixed-${users}-run-${runNumber}`);
      const now=performance.now();
      if(now>=nextHeartbeat){
        await request(session,'POST',projectPath(f)+'/presence',{clientId,...(index<2?{draftId:f.draft}: {})},{expected:[204],label:'heartbeat'});
        await request(session,'GET',projectPath(f)+'/presence',undefined,{label:'presence'}); nextHeartbeat=now+5000;
      }
      if(index<2&&now>=nextEvent){
        const events=(await request(session,'GET',draftPath(f)+`/events?after=${cursor}`,undefined,{label:'events'})).json(); cursor=events.cursor; nextEvent=now+1000;
      }
      if(index<2&&now>=nextSave){
        const state=await snapshot(session,f);const row=state.records[index];
        await request(session,'PATCH',draftPath(f)+`/records/${row.id}`,{field:'expectedOutput',value:`运行-${users}-${runNumber}-${index}-${Math.round(now)}`,expectedFieldRevision:row.expectedOutputRevision},{label:'autosave'});
        nextSave=now+5000+random()*5000;
      }
      const choice=random();
      if(choice<0.18) await request(session,'GET',projectPath(f)+'/solo-test-sets?limit=10&offset=0',undefined,{label:'test-set-list'});
      else if(choice<0.28) await request(session,'GET',projectPath(f)+'/collections',undefined,{label:'collections'});
      else if(choice<0.55) await request(session,'GET',versionPath(f)+`/records?limit=20&offset=${Math.floor(random()*5)*20}`,undefined,{label:'version-page'});
      else if(choice<0.73) await request(session,'GET',versionPath(f)+'/records?limit=20&search='+encodeURIComponent('问题-baseline-10000-000'),undefined,{label:'version-search'});
      else if(choice<0.86) await request(session,'GET',versionPath(f)+'/provenance?limit=20',undefined,{label:'provenance'});
      else if(choice<0.95) await request(session,'GET',projectPath(f)+'/members',undefined,{label:'members'});
      else if(choice<0.975&&index<2) await request(session,'GET',draftPath(f)+'/selected-sources',undefined,{label:'selected-sources'});
      else await request(session,'GET',versionPath(f)+'/data.csv',undefined,{label:'mixed-download'});
      // Schedule polling separately from business think time without multiplying users.
      const target=performance.now()+2000+random()*3000;
      while(performance.now()<target&&performance.now()<end) {
        await delay(Math.max(0,Math.min(1000,target-performance.now())));
        if(performance.now()>=nextHeartbeat){await request(session,'POST',projectPath(f)+'/presence',{clientId,...(index<2?{draftId:f.draft}:{})},{expected:[204],label:'heartbeat'});await request(session,'GET',projectPath(f)+'/presence',undefined,{label:'presence'});nextHeartbeat=performance.now()+5000;}
        if(index<2&&performance.now()>=nextEvent){const events=(await request(session,'GET',draftPath(f)+`/events?after=${cursor}`,undefined,{label:'events'})).json();cursor=events.cursor;nextEvent=performance.now()+1000;}
      }
    }
    await request(session,'DELETE',projectPath(f)+`/presence/${clientId}`,undefined,{expected:[204],label:'leave-presence'});
  });
  try {await Promise.all(work);await status();}
  catch(error){stop=true;throw error;}
  finally{clearInterval(ticker);}
  await appendFile(`${evidence}/completed.jsonl`,JSON.stringify({mode:'load',users,run:runNumber,durationMs,warmupMs,finished:new Date().toISOString()})+'\n');
}
try {
  if(mode==='setup') await setup();
  else if(mode==='preflight') await correctness();
  else if(mode==='baseline') await baseline();
  else if(mode==='load') await load(Number(process.argv[3]),Number(process.argv[4]));
  else throw new Error('unknown_mode');
  console.log(JSON.stringify({mode,status:'completed'}));
} catch(error) {
  await writeFile(`${evidence}/failure.json`,JSON.stringify({mode,error:error.message,at:new Date().toISOString()}));
  console.error(JSON.stringify({mode,error:error.message}));process.exitCode=1;
}
