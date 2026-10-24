import {test,expect} from '@playwright/test';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createHandler as sessionHandler} from '../api/session.mjs';
import {createHandler as workspaceHandler} from '../api/workspaces.mjs';
import {createHandler as membershipHandler} from '../api/memberships.mjs';
import {createCustomerDashboard} from '../src/http/customer-dashboard.mjs';
import {mockRes} from '../test/oauth-helpers.mjs';
async function fixture(context) {
 const redis=createMemoryRedis();let signedIn=true,userId='user_Customer00001',email='owner@example.com';
 const deps={redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_SIGNUP_OPEN:'1'},session:async()=>signedIn?{status:'signed-in',userId,email,sessionId:'sess_test'}:{status:'signed-out'},revokeSession:async()=>{signedIn=false;}};
 const handlers={'/api/session':sessionHandler(deps),'/api/workspaces':workspaceHandler(deps),'/api/memberships':membershipHandler(deps)};
 const customer=createCustomerDashboard(deps);
 await context.route('**/api/**',async route=>{
  const r=route.request(),u=new URL(r.url()),res=mockRes();
  const req={url:u.pathname+u.search,method:r.method(),headers:{...r.headers(),host:u.host},query:Object.fromEntries(u.searchParams),body:r.postData()?JSON.parse(r.postData()):undefined};
  await (handlers[u.pathname]||customer)(req,res);
  await route.fulfill({status:res.statusCode,headers:res.headers,body:String(res.body||'')});
 });
 return {redis,loginAs:(id,address)=>{userId=id;email=address;signedIn=true;}};
}
test('customer creates workspace and spaces, adds work, and signs out',async({page,context})=>{
 await fixture(context);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/app');
 await expect(page.getByRole('heading',{name:'Create your workspace'})).toBeVisible();
 await page.getByLabel('Workspace name').fill('Northside Repairs');
 await page.getByLabel('First space name').fill('Operations');
 await page.getByRole('button',{name:'Create workspace',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 await page.getByRole('link',{name:'Add a task',exact:true}).click();
 await page.getByLabel('What needs to happen?').fill('Confirm Friday appointments');
 await page.getByRole('button',{name:'Add task',exact:true}).click();
 await expect(page.getByText('Confirm Friday appointments').first()).toBeVisible();
 // Workspace settings is available on both phone and desktop.
 await page.goto('/app#/account');
 await expect(page.getByRole('heading',{name:'Northside Repairs',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Create space',exact:true}).last().click();
 await page.getByLabel('Space name', {exact:true}).fill('Sales');
 await page.getByRole('button',{name:'Create space',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 const picker=page.getByRole('combobox',{name:'Space',exact:true}).filter({visible:true}).first();
 await picker.selectOption({label:'Operations'});
 await expect(page.getByText('Confirm Friday appointments').first()).toBeVisible();
 await page.goto('/app#/account');
 await page.getByRole('button',{name:'Sign out',exact:true}).last().click();
 await expect(page.getByRole('link',{name:'Sign in or create an account'})).toBeVisible();
 expect(errors).toEqual([]);
});
test('literal names stay text and creation validation preserves the form',async({page,context})=>{
 await fixture(context);await page.goto('/app');
 await page.getByLabel('Workspace name').fill('<img src=x onerror=alert(1)>');
 await page.getByRole('button',{name:'Create workspace',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 await page.goto('/app#/account');
 await expect(page.getByRole('heading',{name:'<img src=x onerror=alert(1)>',exact:true})).toBeVisible();
 await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('invited teammate sees only the granted space and can accept without an extra workspace',async({page,context})=>{
 const f=await fixture(context);await page.goto('/app');await page.getByLabel('Workspace name').fill('Team business');await page.getByRole('button',{name:'Create workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 await page.goto('/app#/account');await page.getByLabel('Email',{exact:true}).fill('teammate@example.com');await page.getByRole('button',{name:'Create invitation link'}).click();
 const link=await page.getByRole('textbox',{name:'Invitation link. Expires in seven days.'}).inputValue();
 f.loginAs('user_Teammate00001','teammate@example.com');const invited=await context.newPage();await invited.goto(link);
 await expect(invited.getByRole('heading',{name:'Join Team business'})).toBeVisible();await invited.getByRole('button',{name:'Accept invitation'}).click();
 await expect(invited.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 await expect(invited.getByRole('combobox',{name:'Workspace',exact:true}).filter({visible:true}).first()).toHaveValue(/^w/);
 await expect(invited.getByRole('heading',{name:'Create your workspace'})).toHaveCount(0);
});
