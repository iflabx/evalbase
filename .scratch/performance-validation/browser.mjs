import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const {chromium,expect}=createRequire('/workspace/package.json')('@playwright/test');
const f=JSON.parse(await readFile('/evidence/fixture.json','utf8'));
const base='http://127.0.0.1:4240';
const browser=await chromium.launch({headless:true});
const contexts=[];
const results={syncMs:[],blurToSavedMs:[],navigationMs:[],requestBytes:[],longTasks:[],jsErrors:[],viewportOverflow:[]};
async function pageFor(role) {
  const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);
  await context.addInitScript(()=>{window.__perfLongTasks=[];new PerformanceObserver(list=>window.__perfLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});});
  const response=await context.request.post(base+'/api/session',{headers:{origin:base},data:{email:role+'@perf.test',password:process.env.PERF_PASSWORD}});
  expect(response.ok()).toBeTruthy();
  const page=await context.newPage();
  page.on('pageerror',error=>results.jsErrors.push(error.name));
  page.on('response',async response=>{if(new URL(response.url()).pathname.endsWith('/records'))results.requestBytes.push((await response.body().catch(()=>Buffer.alloc(0))).length);});
  return page;
}
try {
  const [admin,editor,viewer]=await Promise.all(['admin','editor','viewer'].map(pageFor));
  const draft=`/projects/${f.project}/test-sets/drafts/${f.smallDraft}`;
  const formal=`/projects/${f.project}/test-sets/${f.samples[0].testSetId}?version=${f.samples[0].versionId}`;
  const started=performance.now();
  await Promise.all([admin.goto(base+draft),editor.goto(base+draft),viewer.goto(base+formal)]);
  await Promise.all([admin.locator('tbody tr').first().waitFor(),editor.locator('tbody tr').first().waitFor(),viewer.locator('tbody tr').first().waitFor()]);
  results.navigationMs.push(performance.now()-started);
  await expect(admin.locator('header').getByLabel('在线成员').getByRole('img')).toHaveCount(3,{timeout:10000});
  await Promise.all([admin.locator('tbody tr').first().click(),editor.locator('tbody tr').first().click()]);
  const ap=admin.getByLabel('记录编辑区'),ep=editor.getByLabel('记录编辑区');
  const aq=ap.getByRole('textbox',{name:'问题',exact:true}),eq=ep.getByRole('textbox',{name:'问题',exact:true});
  for(let i=0;i<20;i++) {
    const value=`浏览器同步-${i}`;
    await aq.fill(value);const before=performance.now();await aq.blur();
    await expect(admin.getByText('已保存',{exact:true})).toBeVisible();
    results.blurToSavedMs.push(performance.now()-before);const confirmed=performance.now();
    await expect(eq).toHaveValue(value,{timeout:5000});results.syncMs.push(performance.now()-confirmed);
  }
  const ek=ep.getByRole('textbox',{name:'第 1 项 Metadata 字段名'});
  await ek.fill('备注');await eq.focus();
  await expect(editor.getByText('已保存',{exact:true})).toBeVisible();
  await expect(ap.getByRole('textbox',{name:'第 1 项 Metadata 字段名'})).toHaveValue('备注',{timeout:5000});
  await expect(ap.getByRole('textbox',{name:'第 1 项 Metadata 值'})).toHaveValue('');
  await expect(admin.getByRole('button',{name:'采用对方输入'})).toHaveCount(0);
  let release,held;
  const gate=new Promise(resolve=>release=resolve),intercepted=new Promise(resolve=>held=resolve);
  await editor.route('**/api/projects/**/collaborative-drafts/**/records/**',async route=>{
    if(route.request().method()==='PATCH'&&route.request().postDataJSON().field==='question'){held();await gate;}
    await route.continue();
  });
  await eq.fill('浏览器保留的本地输入');await eq.blur();await intercepted;
  await aq.fill('浏览器已保存的竞争输入');await aq.blur();
  await expect(admin.getByText('已保存',{exact:true})).toBeVisible();release();
  await expect(editor.getByText('问题冲突')).toBeVisible({timeout:7000});
  await expect(eq).toHaveValue('浏览器保留的本地输入');
  await editor.unroute('**/api/projects/**/collaborative-drafts/**/records/**');
  await editor.getByRole('button',{name:'保留我的输入'}).click();
  await editor.getByRole('button',{name:'重试保存',exact:true}).click();
  await expect(aq).toHaveValue('浏览器保留的本地输入',{timeout:5000});
  // A background tab resumes normally; the network remains connected throughout.
  let events=0;
  editor.on('request',r=>{if(new URL(r.url()).pathname.endsWith('/events'))events++;});
  await editor.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await editor.waitForTimeout(300);const before=events;await editor.waitForTimeout(2400);expect(events).toBe(before);
  await editor.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await editor.waitForTimeout(2400);expect(events).toBeGreaterThan(before);
  const extra=await contexts[0].newPage();await extra.goto(base+draft);
  await expect(admin.locator('header').getByLabel('在线成员').getByRole('img')).toHaveCount(3);
  await extra.close();
  for(const page of [admin,editor,viewer]) {
    results.longTasks.push(await page.evaluate(()=>window.__perfLongTasks));
    results.viewportOverflow.push(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
  }
  await admin.screenshot({path:'/evidence/browser-desktop.png',fullPage:true});
  await admin.setViewportSize({width:960,height:900});
  await admin.screenshot({path:'/evidence/browser-narrow.png',fullPage:true});
  results.narrowOverflow=await admin.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  await admin.reload();await admin.locator('tbody tr').first().click();await expect(ap.getByRole('textbox',{name:'问题',exact:true})).toHaveValue('浏览器保留的本地输入');
  results.status='passed';
  await writeFile('/evidence/browser-complete','passed');
} catch(error) {
  results.status='failed';results.error=error.message.slice(0,400);process.exitCode=1;
} finally {
  await writeFile('/evidence/browser-result.json',JSON.stringify(results,null,2));
  await Promise.all(contexts.map(c=>c.close()));await browser.close();
  console.log(JSON.stringify({status:results.status,syncSamples:results.syncMs.length,error:results.error}));
}
