import {test,expect} from '@playwright/test';
async function mount(page,{agent=false,task=false}={}) {
 await page.route('**/launchpad-fixture',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/ds/tokens/logmem.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/launchpad.css"><div id="fixture"></div><script type="module">
 import {html,render} from '/vendor/lit-html-3.2.1/lit-html.js';
 import {state} from '/app/core.js';import {launchpad} from '/app/launchpad.js';
 Object.assign(state,{customer:true,space:'demo',workspaceId:'w',spaceId:'s',user:{id:'self'},permissions:{write:true,manage:true}});
 window.draw=()=>render(launchpad({data:{agents:${agent?"[{seen:{state:'idle',since:'1h'}}]":"[{seen:{state:'unknown',since:'never'}}]"},plans:${task?'[{jobs:1}]':'[]'}},space:'demo',refresh:async()=>window.draw()}),document.getElementById('fixture'));window.draw();</script>`}));
 await page.goto('/launchpad-fixture');
}
test('setup requires real entry evidence and keeps scoped solo choice',async({page})=>{
 await mount(page);
 await expect(page.getByText('0 of 3 steps complete',{exact:false})).toBeVisible();
 await expect(page.getByText('Entry verified',{exact:false})).toHaveCount(0);
 await page.getByRole('button',{name:'I am working solo'}).click();
 await expect(page.getByText('1 of 3 steps complete',{exact:false})).toBeVisible();
 await page.reload();
 await expect(page.getByText('You chose to work solo in this space.',{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('task ideas save once and progress remains after source refresh',async({page})=>{
 const writes=[];
 await page.route('**/api/work?*',async route=>{writes.push(route.request().postDataJSON());await route.fulfill({contentType:'application/json',body:'{"ok":true,"job":"test"}'});});
 await mount(page,{agent:true});
 await page.getByRole('button',{name:'Write our product README',exact:true}).click();
 await expect(page.getByLabel('What should your team build or fix?')).toHaveValue('Write our product README');
 await page.getByRole('button',{name:'Save first task'}).click();
 await expect(page.getByText('2 of 3 steps complete',{exact:false})).toBeVisible();
 expect(writes).toHaveLength(1);expect(writes[0].title).toBe('Write our product README');
 await page.getByRole('button',{name:'I am working solo'}).click();
 await expect(page.getByText('Workspace setup complete',{exact:true})).toBeVisible();
 await expect(page.getByText('3 of 3 steps complete',{exact:false})).toBeVisible();
});
test('uncertain retry retains task identity and never treats conflict as saved',async({page})=>{
 const ids=[];
 await page.route('**/api/work?*',async route=>{ids.push(route.request().postDataJSON().job);await route.fulfill({status:ids.length===1?500:409,contentType:'application/json',body:'{"error":"Please verify before retrying"}'});});
 await mount(page);
 await page.getByLabel('What should your team build or fix?').fill('Check code');
 await page.getByRole('button',{name:'Save first task'}).click();
 await expect(page.getByRole('alert')).toBeVisible();
 await page.getByRole('button',{name:'Save first task'}).click();
 await expect(page.getByRole('link',{name:'Verify this task'})).toBeVisible();
 expect(ids[0]).toBe(ids[1]);
 await expect(page.getByText('0 of 3 steps complete',{exact:false})).toBeVisible();
});
