import {test,expect} from '@playwright/test';
test('onboarding has one decorative companion and a working static fallback',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'?null:original.call(this,type,...args);};});
 await page.goto('/onboarding');const guide=page.getByRole('complementary',{name:'Setup guide'});await expect(guide).toBeVisible();await expect(page.locator('.ob-orb')).toHaveCount(1);await expect(guide.locator('.ob-orb')).toHaveAttribute('aria-hidden','true');await expect(guide.locator('.ob-orb-fallback')).toBeVisible();await expect(guide).toContainText('Open your workspace');await expect(page.locator('body')).toHaveJSProperty('scrollWidth',await page.evaluate(()=>document.documentElement.clientWidth));
 expect(errors).toEqual([]);await page.screenshot({path:'/private/tmp/logmem-orb-fallback-'+test.info().project.name+'.png',fullPage:true});
});
test('orb respects reduced motion and guidance never claims a connection',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.addInitScript(()=>{window.orbDraws=0;const original=WebGLRenderingContext.prototype.drawArrays;WebGLRenderingContext.prototype.drawArrays=function(...args){window.orbDraws++;return original.apply(this,args);};});
 await page.goto('/onboarding');await expect(page.locator('[data-setup-companion]')).toHaveAttribute('data-gl',/true|false/);await page.evaluate(()=>{document.body.dataset.obStep='connect';});await expect(page.locator('[data-companion-message]')).toHaveText('Connect one agent, then check its first entry.');
 const sample=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.orbDraws)))));
 await expect(page.locator('[data-setup-companion]')).toHaveAttribute('data-gl','true');
 await sample();const a=await sample(),b=await sample();expect(a).toBeGreaterThan(0);expect(b).toBe(a);
 await page.evaluate(()=>{document.body.dataset.obStep='first';});await expect(page.locator('[data-companion-message]')).toContainText('verify your own agent');await page.screenshot({path:'/private/tmp/logmem-orb-'+test.info().project.name+'.png',fullPage:true});
});
