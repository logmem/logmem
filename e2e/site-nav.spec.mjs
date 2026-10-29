import {test,expect} from '@playwright/test';
import {MENU} from '../public/site-nav-model.js';

const PAGES=['/agents','/agents/codex','/skills','/onboarding','/pricing','/connect','/how-to','/privacy','/terms'];

for(const path of PAGES){
  test('phone menu opens and shows every link on '+path,async({page})=>{
    await page.setViewportSize({width:375,height:812});
    await page.goto(path);
    const toggle=page.getByRole('button',{name:'Menu',exact:true});
    await expect(toggle).toBeVisible();
    await expect(page.locator('.nav-cta')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded','true');
    for(const item of MENU)await expect(page.locator('#site-menu').getByRole('link',{name:item.label,exact:true}).first()).toBeVisible();
    await page.getByRole('button',{name:'Agent setup menu'}).click();
    await expect(page.locator('#nav-sub-agents').getByRole('link',{name:'Codex',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-sub-agents')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded','false');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test('desktop sub menu opens, links work, and an outside click closes it',async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await page.goto('/agents');
  await expect(page.getByRole('button',{name:'Menu',exact:true})).toBeHidden();
  await page.getByRole('button',{name:'Agent setup menu'}).click();
  await page.locator('#nav-sub-agents').getByRole('link',{name:'Claude Code',exact:true}).click();
  await expect(page).toHaveURL(/\/agents\/claude-code$/);
  await page.getByRole('button',{name:'Skills menu'}).click();
  await expect(page.locator('#nav-sub-skills')).toBeVisible();
  await page.locator('main').click({position:{x:5,y:5}});
  await expect(page.locator('#nav-sub-skills')).toBeHidden();
});

test('onboarding plan step links to pricing instead of saying there is none',async({page})=>{
  await page.goto('/onboarding?intent=request-invite');
  await expect(page.getByText('No pricing yet')).toHaveCount(0);
});
