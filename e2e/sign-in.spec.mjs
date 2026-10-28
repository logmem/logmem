import {test,expect} from '@playwright/test';
import {signInPage,signInPolicy} from '../src/http/sign-in-page.mjs';
const frontend='https://test-login.clerk.accounts.dev';
const key='pk_test_'+Buffer.from('test-login.clerk.accounts.dev$').toString('base64');
async function loginPage(page,{fail=false,signedIn=false,returnTo='/app?setup=managed'}={}){
 await page.route('**/sign-in?**',route=>route.fulfill({contentType:'text/html',headers:{'content-security-policy':signInPolicy(frontend)},body:signInPage({publishableKey:key,frontend,returnTo})}));
 await page.route(frontend+'/**',route=>{
  if(fail)return route.abort();
  const body=route.request().url().includes('/ui@')?'window.__internal_ClerkUICtor = {};':`window.Clerk={isSignedIn:${signedIn},load:async function(){},mountSignIn:function(root,options){window.__signInOptions=options;root.innerHTML='<form aria-label="Test provider sign-in"><label>Email address<input type="email" aria-label="Email address"></label><button type="button">Continue</button><p>Provider test fixture</p></form>';}};`;
  return route.fulfill({contentType:'text/javascript',body});
 });
}
test('sign-in uses LogMem chrome and provider component with a validated local callback',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await loginPage(page);await page.goto('/sign-in?returnTo=%2Fapp%3Fsetup%3Dmanaged');
 await expect(page.getByRole('heading',{name:'Sign in to LogMem',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'LogMem',exact:true})).toBeVisible();
 await expect(page.getByLabel('Email address')).toBeVisible();
 await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeHidden();
 expect(await page.evaluate(()=>window.__signInOptions.forceRedirectUrl)).toBe('/api/session?signin=1&returnTo=%2Fapp%3Fsetup%3Dmanaged');
 expect(await page.evaluate(()=>window.__signInOptions.appearance.variables.colorPrimary)).toBe('#0b6c68');
 await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));
 await page.screenshot({path:'/private/tmp/logmem-branded-signin-'+test.info().project.name+'.png',fullPage:true});
 expect(errors).toEqual([]);
});
test('provider loading failure preserves branding and offers retry',async({page})=>{
 await loginPage(page,{fail:true});await page.goto('/sign-in?returnTo=%2Fapp');
 await expect(page.getByRole('status')).toContainText('could not load secure sign-in');
 await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'LogMem',exact:true})).toBeVisible();
});
test('existing client session returns through server verification',async({page})=>{
 await loginPage(page,{signedIn:true});await page.route('**/api/session?signin=1&returnTo=*',route=>route.fulfill({contentType:'text/html',body:'<h1>Server session verification</h1>'}));
 await page.goto('/sign-in?returnTo=%2Fapp');
 await expect(page).toHaveURL(/\/api\/session\?signin=1&returnTo=/);
 await expect(page.getByRole('heading',{name:'Server session verification'})).toBeVisible();
});

test('Connections keeps its own server callback',async({page})=>{await loginPage(page,{returnTo:'/connections'});await page.goto('/sign-in?returnTo=%2Fconnections');await expect(page.getByLabel('Email address')).toBeVisible();expect(await page.evaluate(()=>window.__signInOptions.forceRedirectUrl)).toBe('/api/connections?signin=1');});
