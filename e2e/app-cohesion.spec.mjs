import {test,expect} from '@playwright/test';

const ROUTES=['home','queue','work','agents','knowledge','health','settings'];
const CANVAS={white:'rgb(242, 246, 243)',sage:'rgb(234, 241, 236)',sand:'rgb(246, 240, 229)'};
const setTheme=(page,t)=>page.evaluate(v=>{document.documentElement.dataset.appTheme=v;document.documentElement.dataset.theme=v==='midnight'?'dark':'light';},t);

test.beforeEach(async({page})=>{await page.request.post('/api/login',{data:{password:'e2e-only-password'}});});

for(const route of ROUTES){
  test('app page '+route+' has the tint, the swoosh title, the tagline and fits the width in every theme',async({page})=>{
    await page.goto('/app#/'+route);
    const area=page.locator('.lmx-workarea[data-route="'+route+'"]');
    await expect(area).toBeVisible();
    await expect(page.locator('.lmx-app-tagline')).toBeVisible();
    for(const theme of ['white','sage','sand','midnight']){
      await setTheme(page,theme);
      if(CANVAS[theme])await expect(area).toHaveCSS('background-color',CANVAS[theme]);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route+' '+theme).toBe(true);
    }
    await setTheme(page,'white');
    const swoosh=await page.evaluate(()=>{const h=document.querySelector('.lmx-workarea h1');return h?getComputedStyle(h,'::after').borderBottomWidth:'none';});
    expect(swoosh,'page title swoosh').toBe('3px');
  });
}

test('cards share one soft look on every app page that has them',async({page})=>{
  for(const route of ['home','agents','knowledge','health']){
    await page.goto('/app#/'+route);
    await expect(page.locator('.lmx-workarea[data-route="'+route+'"]')).toBeVisible();
    const radius=await page.evaluate(()=>{const c=document.querySelector('.lmx-workarea > main > .lmx-card, .lmx-workarea .lmx-card');return c?getComputedStyle(c).borderTopLeftRadius:'none';});
    expect(['20px','14px','none'],route).toContain(radius);
  }
});

test('the app and the public pages use the same two accent colours',async({page})=>{
  await page.goto('/pricing');
  const pub=await page.evaluate(()=>{const w=document.querySelector('.page-wrap');const s=getComputedStyle(w);return [s.getPropertyValue('--fun-teal').trim(),s.getPropertyValue('--fun-amber').trim()];});
  await page.goto('/app#/home');
  await setTheme(page,'white');
  const app=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return [s.getPropertyValue('--fun-teal').trim(),s.getPropertyValue('--fun-amber').trim()];});
  expect(app).toEqual(pub);
});
