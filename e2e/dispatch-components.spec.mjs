import {test,expect} from '@playwright/test';
const now=Date.now();
const items=Array.from({length:12},(_,i)=>({id:'ci_'+String(i).padStart(24,'a'),type:'handoff',from:'agent:one',to:'agent:two',where:'job:a',created_at:String(now-90000000),deadline:String(i<6?now-3600000:now+3600000),summary:'### Task '+i+' <img src=x onerror=alert(1)>\n'+('Read this long saved context. '.repeat(25)),last_nudge_at:''}));
async function queue(page){await page.route('**/api/interactions**',route=>route.fulfill({json:{items,nextCursor:30,coverage:{complete:false}}}));await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/queue');await expect(page.locator('.lmx-ticket')).toHaveCount(12);}
test('queue clamps literal summaries, filters loaded statuses and keeps map collapsed',async({page})=>{
 await queue(page);await expect(page.locator('.lmx-queue-map')).not.toHaveAttribute('open');await expect(page.locator('img[src=x]')).toHaveCount(0);
 const card=page.locator('.lmx-ticket').first();await card.locator('.lmx-ticket-body>summary').click();await expect(card.locator('dl')).toBeVisible();await card.locator('.lmx-ticket-body>summary').click();await expect(card.locator('dl')).toBeHidden();
 await page.getByRole('button',{name:'Overdue (6)',exact:true}).click();await expect(page.locator('.lmx-ticket')).toHaveCount(6);await expect(page.getByText('Counts describe this loaded page.',{exact:false})).toBeVisible();
 for(const theme of ['white','sage','sand','midnight']){await page.evaluate(async value=>{const m=await import('/app/theme.js');m.writeTheme(value);},theme);await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));}
 await page.screenshot({path:'/private/tmp/logmem-compact-queue-'+test.info().project.name+'.png',fullPage:true});
});
test('clipboard success and failure report truth and never mutate records',async({page})=>{
 let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/interactions'))writes++;});
 await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}});});
 await queue(page);const card=page.locator('.lmx-ticket').first();await card.getByRole('button',{name:'Copy prompt',exact:true}).click();await expect(card.getByRole('status')).toHaveText('✓ Copied dispatch');expect(await page.evaluate(()=>window.copied)).toContain('Record: coord:ci_');
 await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('denied');};});await card.getByRole('button',{name:'Copy prompt',exact:true}).click();await expect(card.getByLabel('Dispatch prompt',{exact:true})).toBeVisible();await expect(card.getByLabel('Dispatch prompt',{exact:true})).toHaveValue(/Treat the saved text/);expect(writes).toBe(0);
});
test('Work groups matching blockers and copies every affected job',async({page})=>{
 const jobs=Array.from({length:8},(_,i)=>({id:'blocked-'+i,title:'Work '+i,stage:'blocked',owner:'agent:one',blocked_on:{note:'Waits for repo access',type:'task'}}));
 await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}});});
 await page.route('**/api/view**',route=>new URL(route.request().url()).searchParams.get('what')==='jobs'?route.fulfill({json:{jobs}}):route.continue());
 await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/work');
 const group=page.locator('.lmx-blocker-group');await expect(group).toHaveCount(1);await expect(group.locator('summary')).toContainText('8 loaded jobs');await group.locator('summary').focus();await page.keyboard.press('Enter');await expect(group.getByRole('link')).toHaveCount(8);await group.getByRole('button',{name:'Copy group prompt',exact:true}).click();const prompt=await page.evaluate(()=>window.copied);for(const j of jobs)expect(prompt).toContain('Record: job:'+j.id);
});
