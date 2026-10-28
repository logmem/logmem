import {test,expect} from '@playwright/test';
const now=Date.now(),start=now-3600000;
const entries=[{kind:'progress',ts:start},{kind:'handoff',ts:start+600000},{kind:'handoff',ts:start+601000},{kind:'stuck',ts:start+1800000},{kind:'done',ts:now}].map((e,i)=>({...e,summary:'Event '+i,by:'agent:codex',where:'job:a',group:'work'}));
async function open(page){await page.route('**/api/view**',r=>new URL(r.request().url()).searchParams.get('what')==='log'?r.fulfill({json:{entries,space:'fieldnotes',spaces:['fieldnotes']}}):r.fallback());await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/activity');await expect(page.getByRole('region',{name:'Time scrubber'})).toBeVisible();}
test('density peaks jump to real events and the native slider stays keyboard usable',async({page})=>{
 await open(page);const scrub=page.getByRole('region',{name:'Time scrubber'});await expect(scrub.locator('.lmx-density-bar')).toHaveCount(48);await expect(scrub.locator('.lmx-density-stuck')).toHaveCount(1);
 await scrub.getByRole('button',{name:/Peak handoffs \(2\)/}).click();await expect(scrub.getByRole('slider')).toHaveAttribute('aria-valuetext',/3 loaded entries/);await expect(scrub.locator('.lmx-telemetry-pills')).toContainText('Handoffs 2');
 await scrub.getByRole('button',{name:/Stuck peak \(1\)/}).click();await expect(scrub.getByRole('slider')).toHaveAttribute('aria-valuetext',/4 loaded entries/);await scrub.getByRole('slider').focus();await page.keyboard.press('Home');await expect(scrub.getByRole('slider')).toHaveValue('0');await page.keyboard.press('End');await expect(scrub.getByRole('slider')).toHaveValue('1000');
 await scrub.getByRole('button',{name:'Jump to latest loaded entry'}).click();await expect(scrub).toContainText('Latest loaded');
 for(const theme of ['white','sage','sand','midnight']){await page.evaluate(async t=>(await import('/app/theme.js')).writeTheme(t),theme);await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));}
 await page.screenshot({path:'/private/tmp/logmem-activity-telemetry-'+test.info().project.name+'.png',fullPage:true});
});
test('assistant shows bounded snapshots and inspects configured access without writes or navigation',async({page})=>{
 let writes=0;page.on('request',r=>{if(r.method()==='POST'&&!r.url().endsWith('/api/login'))writes++;});
 await page.route('**/api/connections',r=>r.fulfill({json:{apps:[{app:'Claude',agent:'claude',last_used:Math.floor(now/1000)}]}}));await open(page);
 const widget=page.getByRole('complementary',{name:'Workspace assistant'});await expect(widget.getByRole('link',{name:/Source activity/})).toContainText('5 entries · loaded');await expect(widget.getByRole('link',{name:/Health & coverage/})).toContainText('Open to measure');await expect(widget).toContainText('Agent execution: unverified');
 await widget.locator('.lmx-client-inspector>summary').click();await expect(widget).toContainText('Claude');await expect(widget).toContainText('Grant configured');await expect(page).toHaveURL(/#\/activity$/);expect(writes).toBe(0);await expect(widget.getByText('Local MCP Bridge Connected',{exact:true})).toHaveCount(0);
});
test('client inspector handles missing account authentication without signing out the workspace',async({page})=>{
 await page.route('**/api/connections',r=>r.fulfill({status:401,json:{error:'unauthorized'}}));await open(page);const widget=page.getByRole('complementary',{name:'Workspace assistant'});await widget.locator('.lmx-client-inspector>summary').click();await expect(widget).toContainText('Sign in with your account');await expect(page.getByRole('slider',{name:'Moment in this window'})).toBeVisible();
});
test('refresh reads authorized snapshots and keeps failed sources unavailable',async({page})=>{
 await page.route('**/api/interactions**',r=>r.fulfill({json:{items:[{id:'one'},{id:'two'}]}}));
 await page.route('**/api/view**',r=>{const what=new URL(r.request().url()).searchParams.get('what');return what==='home'?r.fulfill({json:{needs_items:[{type:'decision'}]}}):what==='audit'?r.fulfill({status:503,json:{error:'offline'}}):r.fallback();});
 await open(page);const widget=page.getByRole('complementary',{name:'Workspace assistant'});await widget.getByRole('button',{name:'Refresh snapshots'}).click();await expect(widget.getByRole('link',{name:/Inbox/})).toContainText('2 pending · loaded page');await expect(widget.getByRole('link',{name:/Knowledge decisions/})).toContainText('1 waiting sign-off');await expect(widget.getByRole('link',{name:/Health & coverage/})).toContainText('Unavailable');
});
