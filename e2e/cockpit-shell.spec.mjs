import {test,expect} from '@playwright/test';
async function signIn(page){await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/home');}
test('cockpit theme persists and navigation exposes the real work destinations',async({page})=>{
 await signIn(page);
 await expect(page.locator('html')).toHaveAttribute('data-app-theme','white');
 await page.getByRole('radio',{name:'Midnight theme'}).check();await page.reload();
 await expect(page.locator('html')).toHaveAttribute('data-app-theme','midnight');
 await page.getByRole('radio',{name:'White theme'}).check();
 const visibleNav=page.locator('.lmx-rail:visible,.lmx-tabs:visible');
 for(const label of ['Today','Inbox','Work','Team','Knowledge','Health'])await expect(visibleNav.getByRole('link',{name:label,exact:true})).toBeVisible();
 await visibleNav.getByRole('link',{name:'Inbox',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Coordination queue',exact:true})).toBeVisible();
 await expect(page.getByRole('complementary',{name:'Workspace assistant'})).toContainText('Agent execution: unverified');
 const width=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
 expect(width.content).toBeLessThanOrEqual(width.viewport);
});

test('explicit themes choose legible logos independently of system appearance',async({page})=>{
 await page.emulateMedia({colorScheme:'dark'});await signIn(page);
 await expect(page.locator('.lm-rail-brand .logo-l')).toHaveCSS('display','block');
 await expect(page.locator('.lm-rail-brand .logo-d')).toHaveCSS('display','none');
 await page.emulateMedia({colorScheme:'light'});await page.getByRole('radio',{name:'Midnight theme'}).check();
 await expect(page.locator('.lm-rail-brand .logo-d')).toHaveCSS('display','block');
 await expect(page.locator('.lm-rail-brand .logo-l')).toHaveCSS('display','none');
});
test('personal task summary opens the human task drawer',async({page})=>{
 await signIn(page);const tasks=page.getByRole('group',{name:'Workspace status filters'}).getByRole('button',{name:/Tasks/});
 await tasks.click();await expect(page).toHaveURL(/#\/home$/);
 await page.getByRole('button',{name:'Review task',exact:true}).first().click();
 await expect(page.locator('.lmx-drawer')).toBeVisible();
 await expect(page.locator('.lmx-drawer')).toContainText('Needs you');
});

test('palette dots support keyboard selection and keep the saved choice',async({page})=>{
 await signIn(page);
 const white=page.getByRole('radio',{name:'White theme'});
 await white.focus();await page.keyboard.press('ArrowRight');
 await expect(page.getByRole('radio',{name:'Sage theme'})).toBeChecked();
 await expect(page.locator('html')).toHaveAttribute('data-app-theme','sage');
 await page.reload();await expect(page.getByRole('radio',{name:'Sage theme'})).toBeChecked();
 await expect(page.getByRole('group',{name:'Theme',exact:true})).toBeVisible();
});
test('fleet space picker explains where access is managed',async({page})=>{
 await signIn(page);
 const picker=page.locator('.lmx-space-picker:visible').first();
 await picker.locator('summary').click();
 await expect(picker.getByRole('group',{name:'Choose a space'})).toBeVisible();
 await expect(picker.getByRole('link',{name:'Manage space access'})).toHaveAttribute('href','#/settings');
 await expect(picker).toContainText('These are fleet spaces.');
 await expect(picker.getByRole('button',{name:'Invite a teammate'})).toHaveCount(0);
 await expect(picker.getByRole('button',{name:'Add space'})).toHaveCount(0);
});


test('direct queue route renders while the current space is unresolved',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.request.post('/api/login',{data:{password:'e2e-only-password'}});
 await page.route('**/api/interactions**',route=>route.fulfill({json:{items:[],nextCursor:null,coverage:{complete:true,notes:[],errors:[]}}}));
 await page.goto('/app#/queue');
 await expect(page.getByRole('heading',{name:'Coordination queue',exact:true})).toBeVisible();
 // A direct route can paint before the space request resolves.
 await page.evaluate(async()=>{
  const {state}=await import('/app/core.js');
  const {renderView}=await import('/app/shell.js');
  state.space=null;state.spaces=[];
  renderView('queue',['Work','Coordination queue'],'Waiting for space');
 });
 const picker=page.locator('.lmx-space-picker:visible').first();
 await expect(picker.locator('summary')).toHaveAccessibleName('Space: Choose a space');
 await expect(page.locator('#main')).toContainText('Waiting for space');
 expect(errors).toEqual([]);
});
