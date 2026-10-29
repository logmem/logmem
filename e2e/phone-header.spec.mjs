import {test,expect} from '@playwright/test';
// On a phone the app's top bar scrolls away and stays short, so it does not eat the screen.
test('phone top bar is not sticky and uses about a tenth of the screen',async({page,isMobile})=>{
 test.skip(!isMobile,'phone only');
 await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
 for(const route of ['#/home','#/work']){
  await page.goto('/app'+route);
  const head=page.locator('header.lmx-head');
  await expect(head).toBeVisible();
  const {height,position,vh}=await head.evaluate(h=>({height:h.getBoundingClientRect().height,position:getComputedStyle(h).position,vh:innerHeight}));
  expect(position).toBe('static');
  expect(height).toBeLessThan(vh*0.13);
 }
});
