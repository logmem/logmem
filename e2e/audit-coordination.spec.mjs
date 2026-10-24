import {test,expect} from '@playwright/test';
async function signIn(page){await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/audit');await expect(page.locator('.lmx')).toBeVisible();}
async function audit(page,data){await page.route('**/api/view?*',async route=>{const u=new URL(route.request().url());if(u.searchParams.get('what')!=='audit')return route.fallback();await route.fulfill({json:{ok:true,space:'fieldnotes',spaces:['fieldnotes'],days:[],gate:{},pending:{items:[],total:0,counts:{}},coverage:'partial',...data}});});}
test('audit does not present partial empty coverage as an empty backlog',async({page})=>{
 await audit(page,{});await signIn(page);
 await expect(page.getByText('Coverage is incomplete.',{exact:false})).toBeVisible();
 await expect(page.getByText('No open records were returned.',{exact:true})).toBeVisible();
 await expect(page.getByText('Nothing open.',{exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'Open full queue and nudge'}).click();
 await expect(page.getByRole('heading',{name:'Coordination queue',exact:true})).toBeVisible();
});
test('audit shows a real future deadline and links beyond its first page',async({page})=>{
 const deadline=Date.now()+3600000;
 await audit(page,{coverage:'full',pending:{items:[{id:'ci_'+'b'.repeat(24),summary:'Confirm the supplier quote',from:'agent:one',to:'agent:two',where:'job:quote',type:'handoff',created_at:Date.now(),deadline}],total:51,cursor:'1',counts:{handoffs:51,overdue:0}}});
 await signIn(page);await expect(page.getByText('Confirm the supplier quote',{exact:true})).toBeVisible();
 await expect(page.getByText('Showing 1 of 51 returned records.',{exact:true})).toBeVisible();
 await expect(page.locator('td').filter({hasText:new Date(deadline).getFullYear().toString()})).toHaveCount(1);
 await expect(page.getByText(/due in .*ago/)).toHaveCount(0);
 await expect(page.getByRole('link',{name:'Open full queue and nudge'})).toHaveAttribute('href','#/queue');
});
