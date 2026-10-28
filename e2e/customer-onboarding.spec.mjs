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
 await page.getByRole('button',{name:/^Open \(1\)/}).click();
 await expect(page.getByText('Confirm Friday appointments').first()).toBeVisible();
 // Workspace settings is available on both phone and desktop.
 await page.goto('/app#/account');
 await expect(page.getByRole('heading',{name:'Northside Repairs',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Create space',exact:true}).last().click();
 await page.getByLabel('Space name', {exact:true}).fill('Sales');
 await page.getByRole('button',{name:'Create space',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 await page.screenshot({path:'/private/tmp/logmem-customer-'+test.info().project.name+'.png',fullPage:true});
 const picker=page.locator('.lmx-space-picker:visible').first();
 await picker.locator('summary').click();await picker.getByRole('button',{name:'Operations',exact:true}).click();
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
test('walkthrough drafts accept verified identities and stay private after a pending save crosses spaces',async({page,context})=>{
 const f=await fixture(context),userId='user_Customer00001';
 const {createWorkspace,createSpace}=await import('../src/http/workspaces.mjs'),{createStore}=await import('../src/core/store.mjs');
 const {workspace:w,space:a}=await createWorkspace({userId,name:'Business',firstSpaceName:'Operations',requestId:'create-001'},{redis:f.redis});
 await createSpace({userId,workspaceId:w.id,name:'Sales',requestId:'space-002'},{redis:f.redis});await createStore(f.redis,{space:a.namespace}).setWho('job','private-job',{title:'Private operations work'});
 await page.goto('/app#/write/private-job');await page.getByLabel('Title *').fill('Private operations draft');await page.getByLabel('What to do *').fill('Read the private result');
 await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.locator('.lmw-preview')).toBeVisible();await page.getByRole('link',{name:'Back to the writer'}).click();
 let release,arrived;const held=new Promise(r=>release=r),seen=new Promise(r=>arrived=r);
 await page.route('**/api/tasks**',async route=>{if(route.request().method()==='POST'){arrived();await held;}await route.fallback();});
 await page.getByRole('button',{name:'Save walkthrough'}).click();await seen;
 const picker=page.locator('.lmx-space-picker:visible').first();await picker.locator('summary').click();await picker.getByRole('button',{name:'Sales',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 const response=page.waitForResponse(r=>r.url().includes('/api/tasks')&&r.request().method()==='POST');release();await response;
 await expect(page.getByText('Private operations draft',{exact:true})).toHaveCount(0);
 await page.goto('/app#/walk/preview');await expect(page.getByText('Nothing to preview.',{exact:true})).toBeVisible();
});

test('space picker exposes creation and invitation for a workspace owner',async({page,context})=>{
 await fixture(context);await page.goto('/app');
 await page.getByLabel('Workspace name').fill('Picker business');
 await page.getByRole('button',{name:'Create workspace',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 const picker=page.locator('.lmx-space-picker:visible').first();await picker.locator('summary').click();
 await expect(picker.getByRole('button',{name:'Add space'})).toBeVisible();
 await picker.getByRole('button',{name:'Invite a teammate'}).click();
 await expect(page.getByRole('heading',{name:'Invite a teammate',exact:true})).toBeVisible();
});

test('viewer space picker keeps management actions hidden',async({page,context})=>{
 const f=await fixture(context);
 const {createWorkspace,setMembership}=await import('../src/http/workspaces.mjs');
 const {workspace:w,space}=await createWorkspace({userId:'user_Owner000001',name:'Read only business',firstSpaceName:'Operations',requestId:'picker-owner-001'},{redis:f.redis});
 await setMembership({actorId:'user_Owner000001',workspaceId:w.id,userId:'user_Customer00001',role:'viewer',spaces:{[space.id]:{role:'viewer',canApprove:false}},requestId:'picker-viewer-001'},{redis:f.redis});
 await page.goto('/app');
 const picker=page.locator('.lmx-space-picker:visible').first();await picker.locator('summary').click();
 await expect(picker.getByRole('button',{name:'Add space'})).toHaveCount(0);
 await expect(picker.getByRole('button',{name:'Invite a teammate'})).toHaveCount(0);
 await expect(picker).toContainText('Your workspace owner manages spaces and invitations.');
 await expect(picker.getByRole('button',{name:'Workspace settings'})).toBeVisible();
});
