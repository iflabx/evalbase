// Read-only review probes. No application DB, network, provider, or old budget is used.
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + '/') : new URL('./snapshot/', import.meta.url);
const read = p => fs.readFile(new URL(p, root), 'utf8');
const load = async (source, prefix = '') => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(prefix + source)).toString('base64'));
const noImports = s => s.replace(/import[\s\S]*?from\s+"[^"]+";/g, '');
const extract = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
const results = [];
const feedback = await load(noImports(await read('src/assistant/feedback.ts')), 'const planVerificationCurrent=()=>{throw Error("unexpected verification branch")};\n');
for (const reason of ['task_budget_exhausted','background_changed','revision_changed','permission_denied']) {
  const actual = feedback.assistantFeedback({stage:'failed',turnControl:{requiresUpdate:true,updateSaved:false}}, {revision:3,hasBackground:true,recoveryReason:reason});
  assert.equal(actual.kind, 'amendment');
  assert.match(actual.message, /请继续/);
  results.push({probe:'pending-plus-blocker', reason, observed:actual.message, verdict:'gap-reproduced'});
}
const deliverySource = await read('src/assistant/delivery-plan.ts');
const helpers = extract(deliverySource,'export function deliveryGoals(','function changedCount(') + extract(deliverySource,'export function deliveryAdditionClause(','export function reviseDeliveryGoals(');
const planRequest = await load(helpers + noImports(await read('src/assistant/plan-request.ts')), 'const canonicalJson=JSON.stringify;\n');
const props={deliveries:{type:'array',items:{properties:{id:{type:'string'},name:{type:'string'},count:{type:'integer'},classifications:{type:'array'}},if:{required:['id']},else:{required:['name','count','classifications']}}}};
const task={executionPlan:{contractVersion:1,steps:[{action:'generate_candidates',deliveryId:'d1',input:{name:'退款测试',outputCount:4,instructions:'自然完整',classifications:[]}}]}};
const normal=planRequest.preparePlanAmendment(task,props,'退款测试改为5条',3,false);
const truncated=planRequest.preparePlanAmendment(task,props,'退款测试改为5条',3,true);
assert.equal(normal.properties.deliveries.items.required?.includes('id')??false,false);
assert.equal(truncated.properties.deliveries.items.required.includes('id'),true);
results.push({probe:'ordinary-vs-truncated-amendment-schema',normalRequiresId:false,truncatedRequiresId:true,verdict:'contract-difference-reproduced'});
// Exercise the real progress selector; canonical JSON is equivalent for these fixed simple objects.
globalThis.__reviewHash = x => createHash('sha256').update(x).digest('hex');
const recoverySource=await read('src/assistant/recovery.ts');
const progress=await load(extract(recoverySource,'export function recoveryProgressFacts(','/** One decision'), 'const sha256=globalThis.__reviewHash;const canonicalJson=JSON.stringify;\n');
const empty=progress.recoveryProgress({}, {id:'t1',tool_results:[]});
const queried=progress.recoveryProgress({}, {id:'t1',tool_results:[{name:'query_project',status:'succeeded',result:{files:[{id:'f1'}]}}]});
assert.notEqual(empty,queried);
results.push({probe:'read-only-query-counts-as-progress',changed:true,verdict:'gap-reproduced'});
const require=createRequire(process.argv[3] ? pathToFileURL(resolve(process.argv[3])) : new URL('package.json', root));
globalThis.__reviewAjv=require('ajv');
const repairPrompts=[];
globalThis.__reviewGenerate=async args=>{repairPrompts.push(JSON.parse(args.prompt));return {finishReason:'tool-calls',toolCalls:[{toolName:'plan_task',invalid:true,input:{count:repairPrompts.length+5}}]};};
const repair=await load(noImports(await read('src/assistant/tool-repair.ts')), `
const Ajv=globalThis.__reviewAjv;const generateText=globalThis.__reviewGenerate;
const asSchema=x=>x,tool=x=>x,jsonSchema=x=>x,canonicalJson=JSON.stringify;
const isPlainObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const InvalidToolInputError={isInstance:x=>x?.kind==='invalid'};
const ToolChoiceViolationError={isInstance:()=>false};
`);
const correction=repair.argumentRepair({model:{},reserve:async()=>true,check:async()=>true,observed:()=>{},context:async()=>({deliveries:[{id:'d1',count:4}]}),accept:async()=>false});
await correction({toolCall:{toolName:'plan_task',input:'{"count":5}'},tools:{plan_task:{inputSchema:{validate:async()=>({success:false,error:{issues:[{path:'/id',keyword:'required'}]}})}}},inputSchema:async()=>({type:'object',properties:{id:{type:'string'},count:{type:'integer'}},required:['id','count']}),error:{kind:'invalid'}});
assert.equal(repairPrompts.length,2);
assert.deepEqual(repairPrompts[0],repairPrompts[1]);
results.push({probe:'second-repair-prompt',requests:2,identicalPrompts:true,verdict:'gap-reproduced',limitation:'SDK/provider mocked; actual argumentRepair loop and prompt construction executed'});
await fs.writeFile(process.argv[4] ? resolve(process.argv[4]) : new URL('./probe-results.json',import.meta.url),JSON.stringify({networkCalls:0,businessWrites:0,oldBudgetWrites:0,results},null,2));
console.log(JSON.stringify({probes:results.length,confirmed:results.map(x=>x.probe),networkCalls:0},null,2));
