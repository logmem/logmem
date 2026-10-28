import {test,expect} from '@playwright/test';
import {signInPage} from '../src/http/sign-in-page.mjs';
test('skills, connection and sign-in form one themed resumable path',async({page})=>{
 await page.goto('/agents');await page.getByRole('button',{name:'midnight theme',exact:true}).click();
 await page.locator('.agent-card').filter({has:page.getByRole('heading',{name:'OpenCode',exact:true})}).click();
 await expect(page).toHaveURL(/\/agents$/);
 await expect(page.getByRole('heading',{name:'Read skills · OpenCode'})).toBeVisible();
 await page.getByRole('button',{name:'Agent onboarding',exact:true}).click();await expect(page.getByRole('region',{name:'Skill reader'}).locator('pre')).toContainText('LogMem');
 await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('heading',{name:'Connect · OpenCode'})).toBeVisible();
 await page.getByRole('button',{name:'Save and exit',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Resume setup'}).click();
 await expect(page.getByRole('heading',{name:'Connect · OpenCode'})).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-app-theme','midnight');
 await page.getByRole('button',{name:'Previous step'}).click();await expect(page.getByRole('heading',{name:'Read skills · OpenCode'})).toBeVisible();await page.getByRole('button',{name:'Continue',exact:true}).click();
 const link=page.getByRole('link',{name:'Sign in and continue setup'});const url=new URL(await link.getAttribute('href'),'https://logmem.si');
 expect(url.searchParams.get('returnTo')).toBe('/app?setup=guided&client=opencode&step=2#/home');
 await page.route('**/sign-in?**',r=>r.fulfill({contentType:'text/html',body:signInPage({client:'opencode',returnTo:url.searchParams.get('returnTo')})}));
 await link.click();await expect(page.locator('#signin-root')).toHaveAttribute('data-return-to',url.searchParams.get('returnTo'));await expect(page.locator('html')).toHaveAttribute('data-app-theme','midnight');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('hosted guidance and inline skills keep theme and show no false connection',async({page})=>{
 await page.goto('/agents/chatgpt');await page.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(page.locator('lm-agent-guide').getByText('https://logmem.si/api/mcp',{exact:true})).toBeVisible();
 await expect(page.locator('lm-agent-guide').getByText('Availability depends on your client and plan.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('heading',{name:'Verify · ChatGPT'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Open workspace to verify'})).toHaveAttribute('href',/step%3D3/);
 for(const theme of ['white','sage','sand','midnight']){await page.getByRole('button',{name:theme+' theme',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-app-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.goto('/skills');await page.locator('.agent-card').filter({has:page.getByRole('heading',{name:'logmem-decisions',exact:true})}).click();
 await expect(page.getByRole('region',{name:'Skill reader'}).locator('pre')).toContainText('irreversible');await expect(page).toHaveURL(/\/skills$/);
 await page.screenshot({path:'/private/tmp/logmem-continuous-setup-'+test.info().project.name+'.png',fullPage:true});
});
test('inline skill failures retry safely and render source text without execution',async({page})=>{
 let calls=0;await page.route('**/skills/logmem/SKILL.md',r=>r.fulfill({status:++calls===1?503:200,contentType:'text/plain',body:calls===1?'Unavailable':'# Safe skill\n<script>window.skillExecuted=true</script>'}));
 await page.goto('/agents/codex');await page.getByRole('button',{name:'Everyday LogMem',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Could not load this skill');await page.getByRole('button',{name:'Retry skill'}).click();
 await expect(page.getByRole('region',{name:'Skill reader'}).locator('pre')).toContainText('<script>');expect(await page.evaluate(()=>window.skillExecuted)).toBeUndefined();
 await page.getByRole('button',{name:'Save and exit',exact:true}).click();await page.getByRole('button',{name:'Resume setup'}).click();await expect(page.getByRole('heading',{name:'Read skills · Codex'})).toBeVisible();
});
