import {test,expect} from '@playwright/test';

test('app home uses the sign-in look in every theme and keeps phone width',async({page})=>{
  await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
  await page.goto('/app#/home');
  const h1=page.locator('.lmx-workarea[data-route="home"] .lmx-hero h1');
  await expect(h1).toBeVisible();
  await expect(h1.locator('span')).toHaveText(/in view\./);
  await expect(page.getByText('Your business. Your AI team.')).toBeVisible();
  await expect(page.locator('.lmx-hero-note img')).toHaveAttribute('src','/ds/logos/logmem-symbol.svg');
  for(const theme of ['white','sage','sand','midnight']){
    await page.evaluate(t=>{document.documentElement.dataset.appTheme=t;document.documentElement.dataset.theme=t==='midnight'?'dark':'light';},theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.evaluate(()=>{document.documentElement.dataset.appTheme='white';});
  await expect(page.locator('.lmx-workarea[data-route="home"]')).toHaveCSS('background-color','rgb(242, 246, 243)');
  await expect(page.locator('.lmx-workarea[data-route="home"] .lmx-triage-strip')).toHaveCSS('border-top-left-radius','20px');
});
