import {test,expect} from '@playwright/test';

test('homepage hub draws in How it works, adds entries, and shows the approval moment',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/');
  const hub=page.locator('#network .nh');
  await hub.scrollIntoViewIfNeeded();
  await expect(hub).toBeVisible();
  await expect(hub).toHaveAttribute('data-layout','wide');
  await expect(hub.locator('.lm-demo')).toBeVisible();
  await expect(hub.locator('.nh-node')).toHaveCount(6);
  await expect(hub.locator('.nh-event[data-new="true"]').first()).toBeVisible({timeout:12000});
  await expect(hub.locator('.nh-node[data-state="waiting"]')).toContainText('Waiting on you',{timeout:30000});
  await expect(hub.locator('.nh-event .lm-kind',{hasText:'approval'})).toBeVisible();
});

test('pause stops new entries and play resumes them',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/');
  const hub=page.locator('#network .nh');
  await hub.scrollIntoViewIfNeeded();
  const pause=hub.getByRole('button',{name:'Pause'});
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(hub.getByRole('button',{name:'Play'})).toHaveAttribute('aria-pressed','true');
  const top=()=>hub.locator('.nh-event').first().innerText();
  const before=await top();
  await page.waitForTimeout(4000);
  expect(await top()).toBe(before);
  await hub.getByRole('button',{name:'Play'}).click();
  await expect.poll(top,{timeout:12000}).not.toBe(before);
});

test('reduced motion draws the finished story once and keeps still',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/');
  const hub=page.locator('#network .nh');
  await hub.scrollIntoViewIfNeeded();
  await expect(hub.locator('.nh-event')).toHaveCount(5);
  await expect(hub.getByRole('button',{name:'Pause'})).toBeHidden();
  const before=await hub.locator('.nh-events').innerText();
  await page.waitForTimeout(2500);
  expect(await hub.locator('.nh-events').innerText()).toBe(before);
  await expect(hub.locator('.nh-dot')).toHaveCount(0);
  await expect(hub.locator('.nh-event',{hasText:'Approved. Send issue 14'})).toHaveCount(1);
});

test('phone uses the tall layout in every theme without sideways scroll',async({page})=>{
  await page.setViewportSize({width:375,height:812});
  await page.goto('/');
  const hub=page.locator('#network .nh');
  await hub.scrollIntoViewIfNeeded();
  await expect(hub).toHaveAttribute('data-layout','tall');
  for(const t of ['white','sage','sand','midnight']){
    await page.evaluate(v=>{document.documentElement.dataset.appTheme=v;document.documentElement.dataset.theme=v==='midnight'?'dark':'light';},t);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),t).toBe(true);
    const box=await hub.boundingBox();
    expect(box.width).toBeLessThanOrEqual(375);
    await expect(hub.locator('.nh-ledger')).toBeVisible();
  }
});
