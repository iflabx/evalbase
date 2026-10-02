import {createRequire} from 'node:module';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const {chromium,expect}=createRequire('/workspace/package.json')('@playwright/test');
const f=JSON.parse(await readFile('/evidence/fixture.json','utf8')),base='http://127.0.0.1:4240';
let browser,context,page,writePage,currentRole,nextSave=0;
try {
browser=await chromium.launch({headless:true});
await writeFile('/evidence/browser-version.json',JSON.stringify({playwright:createRequire('/workspace/package.json')('@playwright/test/package.json').version,chromium:browser.version()}));
const url=base+`/projects/${f.project}/test-sets/${f.loadSample.testSetId}?version=${f.loadSample.versionId}`;
let epoch='',active=false;
await writeFile('/evidence/browser-probe-ready','ready');
  while(!await readFile('/evidence/heavy-complete').then(()=>true).catch(()=>false)&&!await readFile('/evidence/heavy-failure.json').then(()=>true).catch(()=>false)) {
    if(await readFile('/evidence/STOP.json').then(()=>true).catch(()=>false))break;
    const command=await readFile('/evidence/probe-command.json','utf8').then(JSON.parse).catch(()=>({}));
    if(command.epoch&&command.epoch!==epoch){
      active=command.active;epoch=command.epoch;
      if(active){
        const freshContext=currentRole!==command.role;
        if(freshContext){
          if(context)await context.close();
          context=await browser.newContext({viewport:{width:1440,height:900}});page=await context.newPage();writePage=undefined;currentRole=command.role;
          const login=await context.request.post(base+'/api/session',{headers:{origin:base},data:{email:`${currentRole}@perf.test`,password:process.env.PERF_PASSWORD}});expect(login.ok()).toBeTruthy();
          page.on('pageerror',e=>appendFile('/evidence/browser-heavy-errors.jsonl',JSON.stringify({error:e.name})+'\n'));
          await context.addInitScript(()=>{window.__perfLongTasks=[];new PerformanceObserver(list=>window.__perfLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});});
        }
        const began=performance.now();await page.goto(url);await page.locator('tbody tr').first().waitFor();await appendFile('/evidence/browser-heavy-actions.jsonl',JSON.stringify({action:'navigation',phase:command.phase,users:command.users,role:currentRole,initialContext:freshContext,beforeHeavyOperation:true,ms:performance.now()-began,longTasks:await page.evaluate(()=>window.__perfLongTasks.splice(0)),at:new Date().toISOString()})+'\n');
        if(currentRole==='editor'){
          writePage??=await context.newPage();
          await writePage.goto(base+`/projects/${f.project}/test-sets/drafts/${f.smallDraft}`);await writePage.locator('tbody tr').nth(1).click();nextSave=0;
        }
      }
      else{if(page)await page.goto('about:blank');if(writePage)await writePage.goto('about:blank');}
      await writeFile('/evidence/probe-ack.json',JSON.stringify({epoch}));
    }
    if(active){
      if(currentRole==='editor'&&performance.now()>=nextSave){
        const field=writePage.getByLabel('记录编辑区').getByRole('textbox',{name:'期望输出',exact:true});
        const value=`重操作浏览器保存-${Math.round(performance.now())}`;await field.fill(value);
        const saved=writePage.waitForResponse(response=>response.url().includes(`/collaborative-drafts/${f.smallDraft}/records/`)&&response.request().method()==='PATCH'&&response.request().postDataJSON()?.field==='expectedOutput'&&response.request().postDataJSON()?.value===value);
        const began=performance.now();await field.blur();expect((await saved).ok()).toBeTruthy();
        await expect(writePage.getByText('已保存',{exact:true})).toBeVisible();
        await appendFile('/evidence/browser-heavy-actions.jsonl',JSON.stringify({action:'blur-to-saved',phase:command.phase,users:command.users,role:currentRole,ms:performance.now()-began,at:new Date().toISOString()})+'\n');nextSave=performance.now()+5000;
      }
      const began=performance.now(),previous=await page.locator('tbody tr').first().innerText();const next=page.getByRole('button',{name:'下一页',exact:true});
      if(await next.isEnabled())await next.click();else await page.getByRole('button',{name:'上一页',exact:true}).click();
      await expect.poll(async()=>{const row=page.locator('tbody tr').first();return await row.isVisible()&&(await row.innerText())!==previous;},{timeout:10000}).toBe(true);
      await appendFile('/evidence/browser-heavy-actions.jsonl',JSON.stringify({action:'page',phase:command.phase,users:command.users,role:currentRole,ms:performance.now()-began,longTasks:await page.evaluate(()=>window.__perfLongTasks.splice(0)),at:new Date().toISOString()})+'\n');
    }
    await delay(active?1500:200);
  }
}catch(error){await writeFile('/evidence/browser-heavy-failure.json',JSON.stringify({error:error.message.slice(0,400)}));process.exitCode=1;}
finally{if(context)await context.close();if(browser)await browser.close();}
