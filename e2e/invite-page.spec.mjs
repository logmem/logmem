import {test,expect} from '@playwright/test';
const TOKEN='lmi_test-token-for-e2e';
const session={user:{id:'user_Invitee01',email:'invitee@example.test'},workspaces:[],spaces:[],selected:null,onboarding:true};
const json=(route,status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});

test('signed-out invitee sees the invite page, not the generic sign-in',async({page})=>{
 await page.route('**/api/session*',r=>json(r,401,{error:'sign_in_required'}));
 await page.goto('/app?invite='+TOKEN);
 await expect(page.getByRole('heading',{name:'You have been invited to LogMem.'})).toBeVisible();
 const link=page.getByRole('link',{name:'Sign in to accept'});
 const href=new URL(await link.getAttribute('href'),'http://x');
 expect(href.searchParams.get('returnTo')).toBe('/app?invite='+TOKEN);
 await expect(page.locator('body')).not.toContainText(TOKEN);
});

test('signed-in invitee accepts, then gets the short prompt',async({page})=>{
 await page.route('**/api/session*',r=>json(r,200,session));
 await page.route('**/api/memberships*',r=>r.request().method()==='GET'
  ?json(r,200,{workspaceName:'Acme Co',role:'member',spaces:[{name:'Operations'}]})
  :json(r,200,{selected:null}));
 await page.goto('/app?invite='+TOKEN);
 await expect(page.getByRole('heading',{name:'Join Acme Co'})).toBeVisible();
 await expect(page.getByText('invitee@example.test')).toBeVisible();
 await page.getByRole('button',{name:'Accept invitation'}).click();
 await expect(page.getByRole('heading',{name:'You joined Acme Co.'})).toBeVisible();
 await expect(page.locator('.lmx-invite-prompt')).toContainText('https://logmem.si/agents');
 await expect(page.getByRole('link',{name:'Open the agent setup page'})).toHaveAttribute('href','https://logmem.si/agents');
});

test('wrong account gets a clear explanation and a way out',async({page})=>{
 await page.route('**/api/session*',r=>json(r,200,session));
 await page.route('**/api/memberships*',r=>json(r,404,{error:'not_found'}));
 await page.goto('/app?invite='+TOKEN);
 await expect(page.getByRole('heading',{name:'This invitation does not open for your account.'})).toBeVisible();
 await expect(page.getByText('invitee@example.test')).toBeVisible();
 await expect(page.getByRole('button',{name:'Sign out and use another email'})).toBeVisible();
});
