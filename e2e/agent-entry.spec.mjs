import {test,expect} from '@playwright/test';
import {signInPage} from '../src/http/sign-in-page.mjs';
test('skills-first agent setup stays readable and links to branded client sign-in',async({page})=>{
 await page.goto('/agents');
 await expect(page.getByRole('heading',{name:'Start with the AI you use.'})).toBeVisible();
 await page.locator('.agent-card').filter({has:page.getByRole('heading',{name:'OpenCode',exact:true})}).click();
 await expect(page.getByRole('heading',{name:'Connect OpenCode to LogMem.'})).toBeVisible();
 await expect(page.getByRole('heading',{name:'1. Read the skills first'})).toBeVisible();
 await expect(page.getByText('LOGMEM_REQUIRE_BACKEND=1',{exact:true})).toBeVisible();
 await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));
 await page.screenshot({path:'/private/tmp/logmem-agent-setup-'+test.info().project.name+'.png',fullPage:true});
 await page.route('**/sign-in?client=opencode',route=>route.fulfill({contentType:'text/html',body:signInPage({client:'opencode'})}));
 await page.getByRole('link',{name:'Sign in for OpenCode setup'}).click();
 await expect(page.getByText('Continue OpenCode setup.',{exact:false})).toBeVisible();
 await expect(page.getByRole('link',{name:'Back to OpenCode setup'})).toBeVisible();
 await expect(page.getByRole('status')).toContainText('unavailable');
});
test('hosted and key setup explain their real connection requirements',async({page})=>{
 await page.goto('/agents/chatgpt');
 await expect(page.getByText('https://logmem.si/api/mcp',{exact:true})).toBeVisible();
 await expect(page.getByText('Availability depends on your client and plan.',{exact:false})).toBeVisible();
 await page.goto('/agents/vaulted-key');
 await expect(page.getByRole('link',{name:'Agent keys',exact:true})).toHaveAttribute('href','/keys');
 await expect(page.getByText('Mcp-Session-Id',{exact:true})).toBeVisible();
 await page.goto('/skills');
 await expect(page.getByRole('heading',{name:'Skills before the first task.'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Choose your client setup path →'})).toHaveAttribute('href','/agents');
});
