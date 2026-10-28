import {test,expect} from '@playwright/test';
async function signIn(page){await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/audit');await expect(page.locator('.lmx')).toBeVisible();}
async function audit(page,data){await page.route('**/api/view?*',async route=>{const u=new URL(route.request().url());if(u.searchParams.get('what')!=='audit')return route.fallback();await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],days:[],gate:{},pending:{items:[],total:0,counts:{}},coverage:'partial',...data}});});}
test('audit does not present partial empty coverage as an empty backlog',async({page})=>{
 await audit(page,{});await signIn(page);
 await expect(page.getByText('Older handoffs still need indexing',{exact:false})).toBeVisible();
 await expect(page.getByText('No open records were returned.',{exact:true})).toBeVisible();
 await expect(page.getByText('Nothing open.',{exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'Review requests in Inbox'}).click();
 await expect(page.getByRole('heading',{name:'Coordination queue',exact:true})).toBeVisible();
});
test('audit shows a real future deadline and links beyond its first page',async({page})=>{
 const deadline=Date.now()+3600000;
 await audit(page,{coverage:'full',pending:{items:[{id:'ci_'+'b'.repeat(24),summary:'Confirm the supplier quote',from:'agent:one',to:'agent:two',where:'job:quote',type:'handoff',created_at:Date.now(),deadline}],total:51,cursor:'1',counts:{handoffs:51,overdue:0}}});
 await signIn(page);await expect(page.locator('.lmx-health-row>summary').getByText('Confirm the supplier quote',{exact:true})).toBeVisible();
 await expect(page.getByText('Showing 1 of 51 returned records.',{exact:true})).toBeVisible();
 await expect(page.locator('.lmx-health-deadline').filter({hasText:new Date(deadline).getFullYear().toString()})).toHaveCount(1);
 await expect(page.getByText(/due in .*ago/)).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Review requests in Inbox'})).toHaveAttribute('href','#/queue');
});

test('audit exposes three daily receipts without claiming an active schedule',async({page})=>{
 await audit(page,{slots:[{agent:'codex',date:'2026-10-24',slots:{morning:{state:'pass',attempts:[{outcome:'pass'}]},midday:{state:'partial',attempts:[{}]},closeout:{state:'pending',attempts:[]}}}]});
 await signIn(page);const runs=page.getByLabel('Saved coordination checks',{exact:true});await runs.locator('summary').click();
 await expect(runs.getByRole('columnheader',{name:'Closeout',exact:true})).toBeVisible();
 await expect(runs.getByText('pass',{exact:true})).toBeVisible();
 await expect(runs.getByText('partial',{exact:true})).toBeVisible();
 await expect(runs.getByText('pending',{exact:true})).toBeVisible();
 await expect(runs.getByText('2026-10-24',{exact:true})).toBeVisible();
 await expect(runs.getByRole('link',{name:'codex',exact:true})).toHaveAttribute('href','#/agent/codex');
 await expect(runs.getByText('This page has no scheduler connection',{exact:false})).toBeVisible();
});
test('audit marks missing daily receipts as unknown coverage',async({page})=>{
 await audit(page,{});await signIn(page);
 await page.getByText('Saved coordination checks (0 agents)',{exact:true}).click();
 await expect(page.getByText('No coordination receipts were saved for this date.',{exact:false})).toBeVisible();
});
test('daily slots lets a person select a date and reach Audit',async({page})=>{
 await page.route('**/api/view?*',async route=>{
  const u=new URL(route.request().url());if(u.searchParams.get('what')!=='slots')return route.fallback();
  await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],date:u.searchParams.get('date')||'2026-10-24',agents:[]}});
 });
 await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/slots');
 await page.getByLabel('Run date').fill('2026-10-23');await page.getByLabel('Run date').press('Tab');
 await expect(page).toHaveURL(/#\/slots\/2026-10-23$/);
 await expect(page.getByLabel('Run date')).toHaveValue('2026-10-23');
 await expect(page.getByText('Receipts do not prove an active runner or a configured schedule.',{exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Coordination audit',exact:true})).toHaveAttribute('href','#/audit');
});


test('Health shows measured counts and distinguishes historical source handoffs', async ({page}) => {
 await audit(page,{pending:{items:[{id:'ci_'+'c'.repeat(24),type:'handoff',summary:'Review launch proof',from:'agent:hermes',to:'agent:codex',created_at:Date.now()-172800000,deadline:Date.now()-86400000,read_only:true}],total:1,counts:{handoffs:1,overdue:1}},days:[{date:'2026-10-25',mirror_mismatches:7}],slots:[{agent:'codex',date:'2026-10-25',slots:{morning:{state:'pass',attempts:[{}]}}}]});
 await signIn(page);await page.getByRole('link',{name:'Health',exact:true}).click();
 const summary=page.getByRole('region',{name:'Coordination health summary'});
 await expect(summary).toContainText('Open coordination');
 await expect(summary).toContainText('Agents with saved checks');
 await expect(summary).toContainText('7');
 await page.locator('.lmx-health-row>summary').click();
 await expect(page.getByRole('link',{name:'Read source handoff'})).toHaveAttribute('href','#/agent/codex');
 await expect(page.getByText('Provider usage Not connected',{exact:true})).toHaveCount(0);
});

test('health explains the audit window and reports failed sources without zeroing them',async({page})=>{
 await audit(page,{source_status:{audit:'error',receipts:'error'}});await signIn(page);await page.getByRole('link',{name:'Health',exact:true}).click();
 const metrics=page.getByRole('region',{name:'Coordination health summary'});await expect(metrics).toContainText('Unavailable');
 await page.getByText('About missing compatibility copies',{exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Audit history could not be read. Retry this page.');
 await page.getByText('Saved coordination checks (0 agents)',{exact:true}).click();await expect(page.getByText('Receipt storage could not be read. Retry this page.',{exact:true})).toBeVisible();
});
