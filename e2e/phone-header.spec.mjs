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
// Turned sideways the phone is wide and short. The top bar must still scroll away, and the side rail must fit without its own scroll.
test('phone in landscape keeps a short top bar and a rail that fits',async({page,isMobile})=>{
 test.skip(!isMobile,'phone only');
 await page.setViewportSize({width:915,height:412});
 await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
 for(const route of ['#/home','#/work']){
  await page.goto('/app'+route);
  const head=page.locator('header.lmx-head');
  await expect(head).toBeVisible();
  const m=await page.evaluate(()=>{const h=document.querySelector('header.lmx-head'),r=document.querySelector('.lmx-rail');return{pos:getComputedStyle(h).position,h:h.getBoundingClientRect().height,vh:innerHeight,railOver:r.scrollHeight-r.clientHeight,sw:document.documentElement.scrollWidth,iw:innerWidth}});
  expect(m.pos).toBe('static');
  expect(m.h).toBeLessThan(m.vh*0.2);
  expect(m.railOver).toBeLessThanOrEqual(0);
  expect(m.sw).toBeLessThanOrEqual(m.iw);
 }
});
