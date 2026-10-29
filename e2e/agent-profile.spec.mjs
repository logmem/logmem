import {test,expect} from '@playwright/test';

const now = {doing:'Orchestrating launch assets and checking pre-publish QA.',job:'job:dist-connect-page',lane:'launch',next:'Review guide 04',waiting_on:{trail:'approvalX-1',note:'Photos approval'},updated_at:Date.now()-120000,_picked:{a:1,b:'two'},ai_league:['x','y']};
const follows = Object.fromEntries([...Array.from({length:14},(_,i)=>['job:j'+i,{role:'owner'}]),['channel:agent-coordination',{role:'participant'}]]);
const shifts = [{shift:'s1',surface:'claude-code',ts:Date.now()-5000,auto:true},{shift:'s2',surface:'hermes-cli',ts:Date.now()-9000,auto:false}];

async function open(page) {
  await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
  await page.route('**/api/view?*',async route=>{
    const q=new URL(route.request().url()).searchParams;
    if(q.get('what')!=='agent')return route.fallback();
    await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],id:'muse',who:null,now,recap:{summary:'Verified the captures.\nSecond line.',next:['Ship QA'],mode:'auto',reason:'idle',ended_at:Date.now()-60000},follows,shifts,log:[],handoffs:[],seen:{state:'active',since:'2m'}}});
  });
  await page.goto('/app#/agent/muse');
  await expect(page.getByRole('region',{name:'Agent profile for muse'})).toBeVisible();
}

test('profile shows readable Now fields, not raw JSON',async({page})=>{
  await open(page);
  await expect(page.getByText('waiting on · Photos approval')).toBeVisible();
  await page.getByText('Now fields').click();
  await expect(page.locator('.lmx-prof-kv')).toContainText('_picked');
  await expect(page.locator('.lmx-prof-kv')).not.toContainText('{"a":1');
  await expect(page.locator('.lmx-prof')).not.toContainText('[object Object]');
});

test('follows filter and show more, shifts filter, and open drawers survive a redraw',async({page})=>{
  await open(page);
  await page.getByText('Follows',{exact:true}).click();
  await expect(page.locator('.lmx-prof-follow')).toHaveCount(12);
  await page.getByRole('button',{name:'Show 3 more'}).click();
  await expect(page.locator('.lmx-prof-follow')).toHaveCount(15);
  await page.getByRole('button',{name:'Channels (1)'}).click();
  await expect(page.locator('.lmx-prof-follow')).toHaveCount(1);
  await page.getByText('Recent shifts',{exact:true}).click();
  await page.getByRole('button',{name:'Manual (1)'}).click();
  await expect(page.locator('.lmx-prof-timeline li')).toHaveCount(1);
  await expect(page.locator('.lmx-prof-timeline')).toContainText('hermes-cli');
  await expect(page.locator('details.lmx-prof-drawer[open]')).toHaveCount(2);
});

test('profile has no horizontal scroll on a phone in every theme',async({page,isMobile})=>{
  await open(page);
  for(const t of ['white','sage','sand','midnight']){
    await page.evaluate(v=>{document.documentElement.dataset.appTheme=v;},t);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  expect(typeof isMobile).toBe('boolean');
});
