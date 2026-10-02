import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export { assert, randomUUID, delay };
export const base = process.env.PERF_BASE ?? 'http://web:3000';
export const origin = 'http://127.0.0.1:4240';
export const evidence = '/evidence';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export let phase = process.env.PERF_PHASE ?? 'setup';
export const setPhase = value => { phase = value; };
const output = `${evidence}/requests-${process.env.PERF_RUN ?? 'setup'}.jsonl`;
export async function request(session, method, path, body, options = {}) {
  const scheduled = performance.now();
  const id=randomUUID(),requestPhase=phase,action=options.label??method;
  await appendFile(output.replace('/requests-','/request-starts-'),JSON.stringify({id,at:new Date().toISOString(),phase:requestPhase,action})+'\n');
  const start=performance.now(),loggingMs=start-scheduled;
  let status = 0, bytes = 0, error = null, text = '', response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        origin,
        ...(session ?? {}),
        ...(body !== undefined ? {'content-type': 'application/json'} : {}),
        ...options.headers,
      },
      ...(body === undefined ? {} : {body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)}),
      signal: AbortSignal.timeout(options.timeout ?? 60000),
    });
    status = response.status;
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.length;
    text = buffer.toString();
    const expected = options.expected ?? [200];
    assert(expected.includes(status), `unexpected_status_${status}_${options.label ?? method}`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message.slice(0, 160) : 'unknown';
  }
  await appendFile(output, JSON.stringify({id,at: new Date().toISOString(), phase:requestPhase, action, ms: performance.now()-start,loggingMs, status, bytes, error}) + '\n');
  if (error) throw new Error(error);
  return {response, text, json: text ? JSON.parse.bind(null, text) : () => null, bytes, ms: performance.now()-start};
}
export async function login(role) {
  const password = process.env.PERF_PASSWORD;
  assert(password, 'runtime_password_required');
  const response = await request(null, 'POST', '/api/session', {email: `${role}@perf.test`, password}, {label: 'login'});
  return {cookie: response.response.headers.getSetCookie()[0].split(';')[0], 'x-csrf-token': response.json().csrfToken};
}
export const readFixture = async () => JSON.parse(await readFile(`${evidence}/fixture.json`, 'utf8'));
export const saveFixture = fixture => writeFile(`${evidence}/fixture.json`, JSON.stringify(fixture, null, 2));
export const projectPath = f => `/api/projects/${f.project}`;
export const draftPath = (f, draft = f.draft) => `${projectPath(f)}/collaborative-drafts/${draft}`;
export const versionPath = (f, sample = f.loadSample ?? f.samples[0]) => `${projectPath(f)}/solo-test-sets/${sample.testSetId}/versions/${sample.versionId}`;
export const snapshot = async (session, f, draft = f.draft, query = '') => (await request(session, 'GET', draftPath(f,draft)+query, undefined, {label:'draft-page'})).json();
export async function createDraft(session, f, name, parent) {
  const result = (await request(session,'POST',`${projectPath(f)}/collaborative-drafts`,parent ?? {},{expected:parent?[200,201]:[201],label:'create-draft'})).json();
  if (!parent) await request(session,'PATCH',draftPath(f,result.draft.id),{field:'name',value:name,expectedFieldRevision:0},{label:'save-name'});
  return result.draft.id;
}
export async function publish(session, f, draft, options={}) {
  const state = await snapshot(session,f,draft);
  return (await request(session,'POST',draftPath(f,draft)+'/publish',{revision:state.draft.revision},{expected:[200,201],label:'publish',...options})).json();
}
export function sourceFixture(rows, format='csv', pad=0, salt='seed') {
  const values = Array.from({length:rows},(_,index)=>({question:`问题-${salt}-${String(index).padStart(5,'0')}${'x'.repeat(pad)}`,answer:`期望-${index}`,topic:`主题-${index%5}`,empty:''}));
  if (format === 'json') return JSON.stringify(values);
  if (format === 'jsonl') return values.map(row=>JSON.stringify(row)).join('\n')+'\n';
  return 'question,answer,topic,empty\n'+values.map(row=>`${row.question},${row.answer},${row.topic},`).join('\n')+'\n';
}
export async function upload(session, f, text, name, format='csv') {
  const rows=format==='json'?JSON.parse(text).length:(text.match(/\n/g)?.length??0)-(format==='csv'?1:0);
  await appendFile(`${evidence}/fixture-upload-manifest.jsonl`,JSON.stringify({name,format,rows,rawBytes:Buffer.byteLength(text),sha256:hash(text),phase})+'\n');
  const contentType = {csv:'text/csv',json:'application/json',jsonl:'application/x-ndjson'}[format];
  const raw = (await request(session,'POST',`${projectPath(f)}/pending-uploads`,text,{expected:[201],label:`upload-${format}`,headers:{'content-type':contentType,'x-file-name':name}})).json();
  const pending = raw.pendingUpload.id;
  await request(session,'PUT',`${projectPath(f)}/pending-uploads/${pending}/preview`,{mapping:{question:'/question',expectedOutput:'/answer',metadata:['/topic','/empty']}},{label:'mapping-preview'});
  return pending;
}
export async function confirm(session, f, pending, key=randomUUID()) {
  return (await request(session,'POST',`${projectPath(f)}/pending-upload-batches/confirm`,{collectionId:f.collection,pendingUploadIds:pending},{expected:[200,201],label:'confirm-upload',headers:{'idempotency-key':key}})).json();
}
export async function select(session, f, draft, assetIds, options={}) {
  return (await request(session,'POST',draftPath(f,draft)+'/source-selection',{mode:'add',assetIds},{label:'select-source',...options})).json();
}
