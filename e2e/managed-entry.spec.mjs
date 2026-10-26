import {test,expect} from '@playwright/test';

test('homepage leads invited clients to managed setup without a Redis form',async({page})=>{
 await page.goto('/');
 await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));
 await page.screenshot({path:'/private/tmp/logmem-managed-home-'+test.info().project.name+'.png',fullPage:true});
 await page.getByRole('link',{name:'Open your workspace'}).first().click();
 await expect(page).toHaveURL(/\/onboarding$/);
 await expect(page.getByRole('heading',{name:'Use managed LogMem'})).toBeVisible();
 await expect(page.getByText('Managed access is invite only. Public signup is not open.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Redis URI',{exact:true})).toBeHidden();
 await expect(page.getByRole('button',{name:'Request access',exact:true})).toBeVisible();
 await page.screenshot({path:'/private/tmp/logmem-managed-entry-'+test.info().project.name+'.png',fullPage:true});
});

test('disabled managed login explains the blocker and retries into the customer app',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));let available=false;
 await page.route('**/api/session*',route=>new URL(route.request().url()).searchParams.has('signin')
  ?route.fulfill({status:302,headers:{location:'/app?setup=managed'}})
  :route.fulfill({status:available?401:503,contentType:'application/json',body:JSON.stringify({error:available?'sign_in_required':'customer_dashboard_disabled'})}));
 await page.goto('/onboarding');
 const start=page.getByRole('link',{name:'Open your workspace',exact:true});
 await start.click();
 await expect(page.getByRole('status')).toContainText('Managed login is not available');
 await expect(page).toHaveURL(/\/onboarding$/);
 available=true;await start.click();
 await expect(page).toHaveURL(/\/app\?setup=managed$/);
 await expect(page.getByRole('link',{name:'Sign in or create an account'})).toBeVisible();
 expect(errors).toEqual([]);
});

test('advanced setup and access requests stay separate from managed login',async({page})=>{
 await page.route('**/api/onboarding/probe*',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
 await page.goto('/onboarding');
 await page.getByRole('button',{name:'Request access',exact:true}).click();
 await expect(page.getByRole('heading',{name:'What would you use it for?'})).toBeVisible();
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Join the waitlist.',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await page.getByRole('button',{name:'Set up my own Redis',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Find the AI tools on this machine.'})).toBeVisible();
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByLabel('Workspace name').fill('Northside Repairs');
 await page.getByLabel('Space id',{exact:true}).fill('northside');
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('button',{name:'HTTP REST bridge',exact:true}).click();
 await expect(page.getByLabel('REST URL',{exact:true})).toBeVisible();
 await expect(page.getByLabel('REST token',{exact:true})).toBeVisible();
});
