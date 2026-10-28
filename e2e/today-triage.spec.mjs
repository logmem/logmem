import {test,expect} from '@playwright/test';
const data={plans:[{id:'launch',title:'LogMem launch',jobs:10,done:4,percent:40,lane:{status:'p0'},next_milestone:{id:'g1',title:'G1',date:'2026-11-01'}}],blocked:[{id:'blocked',title:'Waiting for access',stage:'blocked',owner:'agent:one',blocked_on:{type:'agent',ref:'agent:two',note:'Repo access'}}],agents:[],needs_count:8,needs_items:Array.from({length:8},(_,i)=>({trail:'request-'+i,job:'job-'+i,type:i<3?'decision':'task',summary:'Review '+i+': '+('Saved context for the current work. '.repeat(8)),by:'agent:one',created_at:Date.now()-3600000})),recent:[],coverage:{complete:false,notes:[],errors:[]}};
async function open(page){await page.route('**/api/view**',r=>new URL(r.request().url()).searchParams.get('what')==='home'?r.fulfill({json:data}):r.continue());await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/home');await expect(page.locator('.lmx-bento-task')).toHaveCount(8);}
test('Today filters without navigation and keeps one operations sidebar',async({page})=>{
 let mutations=0;page.on('request',r=>{if(r.method()==='POST'&& !r.url().endsWith('/api/login'))mutations++;});await open(page);
 await expect(page.locator('[aria-label="Workspace assistant"]')).toHaveCount(1);await expect(page.locator('.lmx-operations .lmx-assistant')).toHaveCount(1);
 const strip=page.getByRole('group',{name:'Workspace status filters'});await strip.getByRole('button',{name:'3 Decisions',exact:true}).click();await expect(page.locator('.lmx-bento-task')).toHaveCount(3);await expect(page).toHaveURL(/#\/home$/);
 await strip.getByRole('button',{name:'5 Tasks',exact:true}).click();await expect(page.locator('.lmx-bento-task')).toHaveCount(5);await strip.getByRole('button',{name:'1 Waiting',exact:true}).click();await expect(page.locator('#today-board')).toContainText('Waiting for access');await strip.getByRole('button',{name:'4 / 10 Done',exact:true}).click();await expect(page.locator('#today-board')).toContainText('Completion by plan');expect(mutations).toBe(0);
});
test('operations collapses by keyboard and bento actions align',async({page})=>{
 await open(page);const cards=page.locator('.lmx-bento-task');if(test.info().project.name==='laptop'){const a=await cards.nth(0).boundingBox(),b=await cards.nth(1).boundingBox();expect(Math.abs(a.height-b.height)).toBeLessThan(2);}
 const ops=page.locator('.lmx-operations'),summary=ops.locator(':scope>summary');await summary.focus();await page.keyboard.press('Enter');await expect(ops).not.toHaveAttribute('open');await page.keyboard.press('Enter');await expect(ops).toHaveAttribute('open');
 const plan=ops.locator('.lmx-plan-tile');await plan.locator('summary').click();await expect(plan.getByRole('link',{name:/Review plan/})).toHaveAttribute('href','#/plan/launch');
 await expect(page.getByRole('button',{name:'Approve & Dispatch',exact:true})).toHaveCount(0);
 for(const theme of ['white','sage','sand','midnight']){await page.evaluate(async t=>(await import('/app/theme.js')).writeTheme(t),theme);await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));}
 await page.screenshot({path:'/private/tmp/logmem-today-triage-'+test.info().project.name+'.png',fullPage:true});
});
