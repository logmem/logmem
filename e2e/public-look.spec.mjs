import {test,expect} from '@playwright/test';

const PAGES=['/','/docs','/scorecard','/pricing','/agents','/onboarding','/sign-in'];
const CANVAS={white:'rgb(242, 246, 243)',sage:'rgb(234, 241, 236)',sand:'rgb(246, 240, 229)'};

for(const path of PAGES){
  test('public page '+path+' has the shared header, the theme picker, the canvas and fits the width',async({page})=>{
    await page.goto(path);
    const header=page.locator('header.nav[data-site-nav]');
    await expect(header).toBeVisible();
    await expect(page.locator('.setup-theme-picker')).toHaveCount(1);
    await expect(header.locator('a[href="/pricing"]').first()).toBeAttached();
    for(const theme of ['white','sage','sand']){
      await page.evaluate(t=>{document.documentElement.dataset.appTheme=t;document.documentElement.dataset.theme='light';},theme);
      await expect(page.locator('body')).toHaveCSS('background-color',CANVAS[theme]);
    }
    await page.evaluate(()=>{document.documentElement.dataset.appTheme='midnight';document.documentElement.dataset.theme='dark';});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),path+' midnight').toBe(true);
  });
}

test('picking a theme on one public page carries to the others and to the app',async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await page.goto('/pricing');
  await page.locator('.setup-theme-picker').hover();
  await page.getByRole('button',{name:'sage theme',exact:true}).click();
  for(const path of ['/docs','/','/agents']){
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-app-theme','sage');
  }
  await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
  await page.goto('/app#/home');
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','sage');
  await expect(page.locator('.lmx-workarea')).toHaveCSS('background-color',CANVAS.sage);
});

test('the phone menu opens on the homepage, docs and sign-in',async({page})=>{
  await page.setViewportSize({width:375,height:812});
  for(const path of ['/','/docs','/sign-in']){
    await page.goto(path);
    const toggle=page.getByRole('button',{name:'Menu',exact:true});
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('#site-menu').getByRole('link',{name:'Pricing',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),path).toBe(true);
  }
});
