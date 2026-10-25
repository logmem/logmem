import {test,expect} from '@playwright/test';

async function signIn(page, route) {
  await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
  await page.goto('/app#/'+route);
}

test('Knowledge links decisions and discussions to their original records',async({page})=>{
  await page.route('**/api/view?*',async route=>{
    const what=new URL(route.request().url()).searchParams.get('what');
    const data=what==='decisions'?{waiting:[],decided:[{ask:{trail:'quote-approval',summary:'Approve supplier quote'},answer:{by:'human:admin',kind:'decided',summary:'Quote approved after checking delivery',ts:Date.now(),payload:{verdict:'approve'}}}]}:what==='channels'?{channels:[{id:'delivery',last:{summary:'Supplier needs a delivery window',by:'agent:operations',ts:Date.now()}}]}:null;
    if(!data)return route.fallback();
    await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],...data}});
  });
  await signIn(page,'knowledge');
  await expect(page.getByRole('heading',{name:'Knowledge',exact:true})).toBeVisible();
  await expect(page.getByText('Approve supplier quote',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Source comments',exact:true})).toHaveAttribute('href','#/discussion/decision/quote-approval');
  await expect(page.getByRole('link',{name:'Read source entries',exact:false})).toHaveAttribute('href','#/channels/delivery');
  await expect(page.getByText('Decisions come from a bounded source window.',{exact:false})).toBeVisible();
  await page.getByRole('link',{name:'Read source entries',exact:false}).click();
  await expect(page.getByRole('heading',{name:'Activity',exact:true})).toBeVisible();
});

test('Health exposes missing receipts and unknown runtime without false healthy status',async({page})=>{
  await page.route('**/api/view?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('what')!=='audit')return route.fallback();
    await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],days:[],gate:{},coverage:'partial',pending:{items:[],total:0,counts:{}},slots:[]}});
  });
  await signIn(page,'health');
  await expect(page.getByRole('heading',{name:'Health',exact:true})).toBeVisible();
  const status=page.getByRole('region',{name:'Runtime and usage coverage'});
  await expect(status.getByText('Provider usage',{exact:true})).toBeVisible();
  await expect(status.getByText('Not connected',{exact:true})).toBeVisible();
  await expect(page.getByText('Schedule coverage is unknown.',{exact:false})).toBeVisible();
  await expect(page.getByText('Coverage is incomplete.',{exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'Daily receipt calendar',exact:true})).toHaveAttribute('href','#/slots');
  await page.getByRole('link',{name:'Open full queue and nudge'}).click();
  await expect(page.getByRole('heading',{name:'Coordination queue',exact:true})).toBeVisible();
});

test('Knowledge does not offer another recipient approval controls',async({page})=>{
 await page.route('**/api/view?*',async route=>{
  const what=new URL(route.request().url()).searchParams.get('what');
  if(!['decisions','channels'].includes(what))return route.fallback();
  await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],person:'human:admin',waiting:what==='decisions'?[{trail:'for-other',to:'human:other',summary:'Private recipient request',payload:{action:'Review the plan'}}]:[],decided:[],channels:[]}});
 });
 await signIn(page,'knowledge');
 await expect(page.getByText('This request is read-only here.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
});
