import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const {chromium,expect}=createRequire('/workspace/package.json')('@playwright/test');
const f=JSON.parse(await readFile('/evidence/fixture.json','utf8')),base='http://127.0.0.1:4240';
const browser=await chromium.launch({headless:true}),contexts=[],results=[];
try {
  for(const role of ['admin','editor','viewer']) {
    const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);
    const response=await context.request.post(base+'/api/session',{headers:{origin:base},data:{email:role+'@perf.test',password:process.env.PERF_PASSWORD}});expect(response.ok()).toBeTruthy();
    const page=await context.newPage();const began=performance.now();
    await page.goto(base+`/projects/${f.listProject}/test-sets`);await page.locator('tbody tr').first().waitFor();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    results.push({role,action:'100-drafts-100-formal-navigation',ms:performance.now()-began});
    if(role==='viewer') {
      await expect(page.getByRole('group',{name:'按状态筛选测试集'})).toHaveCount(0);
      await expect(page.locator('tbody tr').first().locator('td').nth(4)).toHaveText('已发布');
      await expect(page.getByRole('button',{name:'新建测试集',exact:true})).toHaveCount(0);
    } else {
      const group=page.getByRole('group',{name:'按状态筛选测试集'});
      await expect(page.getByText(/共 200 项测试集与草稿/)).toBeVisible();
      await expect(page.locator('tbody tr').first().locator('td').nth(4)).toHaveText('草稿');
      const previous=await page.locator('tbody tr').first().innerText();
      await page.getByRole('button',{name:'下一页',exact:true}).click();await expect.poll(async()=>{const row=page.locator('tbody tr').first();return await row.isVisible()&&(await row.innerText())!==previous;}).toBe(true);
      await group.getByRole('button',{name:'草稿',exact:true}).click();await expect(page.getByText(/共 100 个草稿/)).toBeVisible();
      await expect(page.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
      await group.getByRole('button',{name:'已发布',exact:true}).click();await expect(page.getByText(/共 100 个正式测试集/)).toBeVisible();
    }
    const input=page.getByRole('textbox',{name:'搜索测试集'});
    await input.fill('列表正式-001');await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr').first()).toContainText('列表正式-001');
    await input.fill('NO_MATCH_PERFORMANCE');await expect(page.getByText('没有匹配结果',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'清除搜索',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(10);
    await expect(page.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
    await page.screenshot({path:`/evidence/list-${role}.png`,fullPage:true});await context.close();
  }
  const pair=await Promise.all(['admin','editor'].map(async role=>{
    const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);
    const session=await context.request.post(base+'/api/session',{headers:{origin:base},data:{email:role+'@perf.test',password:process.env.PERF_PASSWORD}});expect(session.ok()).toBeTruthy();
    const page=await context.newPage();await page.goto(base+`/projects/${f.project}/test-sets/drafts/${f.smallDraft}`);await page.locator('tbody tr').first().click();return page;
  }));
  const [admin,editor]=pair,aq=admin.getByLabel('记录编辑区').getByRole('textbox',{name:'问题',exact:true}),eq=editor.getByLabel('记录编辑区').getByRole('textbox',{name:'问题',exact:true});
  for(let i=0;i<5;i++) {
    let observed;const intercepted=new Promise(resolve=>observed=resolve);let first=true;
    await editor.route('**/api/projects/**/collaborative-drafts/**/records/**',async route=>{
      if(first&&route.request().method()==='PATCH'&&route.request().postDataJSON().field==='question'){
        first=false;const response=await route.fetch();observed();await new Promise(resolve=>setTimeout(resolve,350));await route.fulfill({response});
      } else await route.continue();
    });
    await eq.fill(`较早输入-${i}`);await eq.blur();
    await Promise.race([intercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('response_delay_not_intercepted')),10000))]);
    const latest=`最新输入-${i}`;await eq.fill(latest);await eq.blur();
    await expect(eq).toHaveValue(latest);await expect(aq).toHaveValue(latest,{timeout:10000});
    await expect(editor.getByText('已保存',{exact:true})).toBeVisible();
    await editor.unroute('**/api/projects/**/collaborative-drafts/**/records/**');
  }
  results.push({action:'rapid-input-with-delayed-old-response',status:'passed',iterations:5,syntheticDelayMs:350,performanceSample:false});
  await eq.fill('退出前保存');await editor.getByRole('button',{name:'退出草稿',exact:true}).click();await expect(editor).toHaveURL(new RegExp(`/projects/${f.project}/test-sets$`));
  await editor.goto(base+`/projects/${f.project}/test-sets/drafts/${f.smallDraft}`);await editor.locator('tbody tr').first().click();await expect(eq).toHaveValue('退出前保存');
  await eq.fill('发布前保存');await editor.getByRole('button',{name:'创建版本',exact:true}).click();await expect(editor).toHaveURL(new RegExp(`/projects/${f.project}/test-sets/[^/?]+\\?version=`),{timeout:20000});
  await expect(editor.locator('tbody tr').first()).toContainText('发布前保存');
  results.push({action:'exit-and-publish-flush-focused-field',status:'passed'});
  await writeFile('/evidence/list-browser-complete','passed');
} catch(error) {results.push({status:'failed',error:error.message.slice(0,400)});process.exitCode=1;}
finally {await writeFile('/evidence/list-browser-result.json',JSON.stringify(results,null,2));await browser.close();}
