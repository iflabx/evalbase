// Temporary OPT-50 verification guard. No credentials or prompt/response bodies are logged.
import {readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const dir='/opt50', stateFile=dir+'/budget.json', lock=dir+'/request.lock';
const realFetch=globalThis.fetch;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=()=>JSON.parse(readFileSync(stateFile,'utf8'));
const persist=s=>{const tmp=stateFile+'.'+process.pid;writeFileSync(tmp,JSON.stringify(s,null,2));renameSync(tmp,stateFile);};
export function reserve(s,id,active,generation){
 const prior=s.calls.filter(c=>c.caseId===id), maxGenerated=0;
 if(!Number.isInteger(id)||![7,10].includes(id)||s.closed || prior.length>=24 || s.calls.length>=48 || active.caseMs+12000>240000 || active.totalMs+12000>480000 || generation+prior.reduce((n,c)=>n+(c.generated??c.generationCount??0),0)>maxGenerated)throw Error('OPT50_verification_limit');
 return Math.min(60000,240000-active.caseMs-2000,480000-active.totalMs-2000);
}
export async function requestCase(s,scope){
 if(scope.projectId!==s.projectId)return null;
 let sessionId=scope.sessionId;
 if(!sessionId&&scope.runId){
  const {Pool}=createRequire(process.cwd()+'/package.json')('pg');
  const db=new Pool({connectionString:process.env.DATABASE_URL,max:1});
  try{
   const rows=(await db.query(`SELECT DISTINCT s.id FROM assistant_session s LEFT JOIN assistant_turn t ON t.session_id=s.id JOIN processing_run r ON r.id=$2 AND r.project_id=s.project_id WHERE s.project_id=$1 AND ((r.source->>'kind'='background' AND r.source->>'id'=s.id) OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.tool_results) x WHERE x->'result'->>'runId'=r.id))`,[scope.projectId,scope.runId])).rows;
   if(rows.length!==1)throw Error('OPT50_request_session_unknown');
   sessionId=rows[0].id;
  }finally{await db.end();}
 }
 const entry=Object.entries(s.sessions).find(([,value])=>value===sessionId);
 if(!entry)throw Error('OPT50_request_session_not_registered');
 const id=Number(entry[0]);
 if(s.closedCases?.includes(id))throw Error('OPT50_case_closed');
 return id;
}
async function activeTime(s,id){
 const {Pool}=createRequire(process.cwd()+'/package.json')('pg');
 const db=new Pool({connectionString:process.env.DATABASE_URL,max:1});
 let rows;
 try{await db.query('BEGIN READ ONLY');rows=(await db.query('SELECT id,task FROM assistant_session WHERE project_id=$1 ORDER BY created_at,id',[s.projectId])).rows;await db.query('COMMIT');}finally{await db.end();}
 if(rows.length>2)throw Error('OPT50_unexpected_session');
 if(!rows.some(r=>r.id===s.sessions[id]))throw Error('OPT50_registered_session_missing');
 const {liveExecutionBudget}=await import("file://"+process.cwd()+"/dist/server/src/assistant/recovery.js");
 const now=Date.now(), byId=new Map(rows.map(r=>[r.id,r.task]));
 const taskMs=key=>{const t=byId.get(s.sessions[key]);return t?Number(liveExecutionBudget(t,now)?.activeMs??0):0;};
 const processingMs=key=>s.calls.filter(c=>c.caseId===Number(key)&&c.purpose!=='assistant').reduce((n,c)=>n+(c.durationMs??c.limitMs),0);
 const elapsed=key=>Math.max(s.calls.filter(c=>c.caseId===Number(key)).reduce((n,c)=>n+(c.durationMs??c.limitMs),0),taskMs(key)+processingMs(key));
 return {caseMs:elapsed(String(id)),totalMs:Object.keys(s.sessions).reduce((n,key)=>n+elapsed(key),0)};
}
if(!process.env.OPT50_GUARD_SELF_TEST)globalThis.fetch=async(input,init)=>{
 const origin=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).origin;
 const identity=init?.[Symbol.for('evalbase.modelRequestScope')], campaign=read();
 if(origin!==campaign.modelOrigin||identity?.projectId!==campaign.projectId)return realFetch(input,init);
 let acquired=false;
 try{
  for(let n=0;!acquired;n++){
   init?.signal?.throwIfAborted();if(n>6000)throw Error('OPT50_guard_busy');
   try{mkdirSync(lock);acquired=true;}catch(e){if(e.code!=='EEXIST')throw e;await wait(10);}
  }
  const s=read(),id=await requestCase(s,identity);
  if(!Number.isInteger(id)||![7,10].includes(id)||s.closed)throw Error('OPT50_inactive_campaign');
  if(s.calls.some(c=>c.durationMs===null))throw Error('OPT50_unknown_previous_request');
  let payload={},message={};try{payload=JSON.parse(typeof init?.body==='string'?init.body:'{}');message=JSON.parse(payload.messages?.at(-1)?.content??'{}');}catch{}
  if(identity.runId && ['generate','augment','rewrite'].includes(message.operation))throw Error('OPT50_processing_operation_forbidden');
  const generation=message.operation==='generate'?Number(message.outputCount):0;
  if(!Number.isSafeInteger(generation)||generation<0)throw Error('OPT50_unknown_generation_scope');
  let active,limitMs;
  try{active=await activeTime(s,id);limitMs=reserve(s,id,active,generation);}catch(e){s.blocked.push({caseId:id,at:new Date().toISOString(),reason:e.message});persist(s);throw e;}
  init?.signal?.throwIfAborted();
  const call={index:s.calls.length+1,caseId:id,sessionId:s.sessions[id],code:s.code,startedAt:new Date().toISOString(),durationMs:null,limitMs,generationCount:generation,generated:generation,purpose:generation?'generation':message.candidates?'content_review':'assistant',requestHash:createHash('sha256').update(typeof init?.body==='string'?init.body:'').digest('hex'),activeBefore:active,httpStatus:null};
  s.calls.push(call);persist(s);const started=Date.now();
  try{
   const response=await realFetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(limitMs)])});call.httpStatus=response.status;
   const reader=response.body?.getReader();const chunks=[];let bytes=0;
   if(reader)for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>8000000){await reader.cancel();throw Error('OPT50_response_capacity');}chunks.push(Buffer.from(item.value));}
   const body=Buffer.concat(chunks);
   if(generation){try{const result=JSON.parse(body.toString());let content=result.choices?.[0]?.message?.content??'';content=content.replace(/^\s*\x60{3}(?:json)?\s*/,'').replace(/\x60{3}\s*$/,'');const value=JSON.parse(content);call.generated=Math.max(generation,Array.isArray(value)?value.length:value.records?.length??0);}catch{}}
   return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(e){call.error=e.name;throw e;}finally{call.durationMs=Date.now()-started;persist(s);}
 }finally{if(acquired)rmdirSync(lock);}
};
