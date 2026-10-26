import {test,expect} from '@playwright/test';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createHandler as sessionHandler} from '../api/session.mjs';
import {createCustomerDashboard} from '../src/http/customer-dashboard.mjs';
import {createWorkspace} from '../src/http/workspaces.mjs';
import {mockRes} from '../test/oauth-helpers.mjs';

test('unsigned managed entry preserves its destination through the sign-in boundary',async({page})=>{
 await page.route('**/api/session*',route=>{
  const url=new URL(route.request().url());
  return route.fulfill(url.searchParams.has('signin')
   ?{status:200,contentType:'text/html',body:'<h1>Provider sign-in boundary</h1>'}
   :{status:401,contentType:'application/json',body:'{"error":"sign_in_required"}'});
 });
 const destination='/app?invite=example-invitation#/account';
 await page.goto('/onboarding?returnTo='+encodeURIComponent(destination));
 await page.getByRole('link',{name:'Open your workspace',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Provider sign-in boundary'})).toBeVisible();
 const final=new URL(page.url());
 expect(final.pathname).toBe('/api/session');
 expect(final.searchParams.get('returnTo')).toBe(destination);
});

for(const requested of ['//evil.test','https://evil.test','/%2f%2fevil.test','/app/../connections','/app?next=bad%']){
 test('managed entry rejects an unsafe return destination: '+requested,async({page})=>{
  await page.route('**/api/session*',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await page.goto('/onboarding?returnTo='+encodeURIComponent(requested));
  await page.getByRole('link',{name:'Open your workspace',exact:true}).click();
  await expect(page).toHaveURL(/\/api\/session\?signin=1&returnTo=/);
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/app?setup=managed');
 });
}

async function signedIn(context,withWorkspace){
 const redis=createMemoryRedis(),userId='user_EntryRouting01';
 if(withWorkspace)await createWorkspace({userId,name:'Entry Business',firstSpaceName:'Operations',requestId:'entry-create-001'},{redis});
 const deps={redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1'},session:async()=>({status:'signed-in',userId,email:'entry@example.test',sessionId:'entry-session'})};
 const session=sessionHandler(deps),customer=createCustomerDashboard(deps);
 await context.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),res=mockRes();
  await (url.pathname==='/api/session'?session:customer)({url:url.pathname+url.search,method:req.method(),headers:{...req.headers(),host:url.host},query:Object.fromEntries(url.searchParams)},res);
  await route.fulfill({status:res.statusCode,headers:res.headers,body:String(res.body||'')});
 });
}
test('signed-in new owner reaches workspace creation from managed onboarding',async({page,context})=>{
 await signedIn(context,false);await page.goto('/onboarding');
 await expect(page.getByRole('heading',{name:'Create your workspace'})).toBeVisible();
});
test('signed-in returning owner reaches the existing space and consumes setup intent',async({page,context})=>{
 await signedIn(context,true);await page.goto('/onboarding');
 await expect(page.getByRole('heading',{name:'Your space is ready.'})).toBeVisible();
 await expect(page).toHaveURL(/\/app#\/home$/);
 await expect(page.getByRole('heading',{name:'Create your workspace'})).toHaveCount(0);
});
