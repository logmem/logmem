import {test,expect} from '@playwright/test';
async function signIn(page){await page.request.post('/api/login',{data:{password:'e2e-only-password'}});await page.goto('/app#/home');}
test('cockpit theme persists and navigation exposes the real work destinations',async({page})=>{
 await signIn(page);
 await expect(page.locator('html')).toHaveAttribute('data-app-theme','white');
 const theme=page.getByRole('combobox',{name:'Theme',exact:true});
 await theme.selectOption('midnight');await page.reload();
 await expect(page.locator('html')).toHaveAttribute('data-app-theme','midnight');
 await theme.selectOption('white');
 const visibleNav=page.locator('.lmx-rail:visible,.lmx-tabs:visible');
 for(const label of ['Today','Inbox','Work','Team','Knowledge','Health'])await expect(visibleNav.getByRole('link',{name:label,exact:true})).toBeVisible();
 await visibleNav.getByRole('link',{name:'Inbox',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Coordination queue',exact:true})).toBeVisible();
 await expect(page.getByRole('complementary',{name:'Workspace assistant'})).toContainText('AI execution is not connected.');
 const width=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
 expect(width.content).toBeLessThanOrEqual(width.viewport);
});

test('explicit themes choose legible logos independently of system appearance',async({page})=>{
 await page.emulateMedia({colorScheme:'dark'});await signIn(page);
 await expect(page.locator('.lm-rail-brand .logo-l')).toHaveCSS('display','block');
 await expect(page.locator('.lm-rail-brand .logo-d')).toHaveCSS('display','none');
 await page.emulateMedia({colorScheme:'light'});await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('midnight');
 await expect(page.locator('.lm-rail-brand .logo-d')).toHaveCSS('display','block');
 await expect(page.locator('.lm-rail-brand .logo-l')).toHaveCSS('display','none');
});
test('personal task summary opens the human task drawer',async({page})=>{
 await signIn(page);const tasks=page.getByRole('link',{name:/Tasks for you/});
 await expect(tasks).toHaveAttribute('href','#/blockers');await tasks.click();
 await expect(page.locator('.lmx-drawer')).toBeVisible();
 await expect(page.locator('.lmx-drawer')).toContainText('Needs you');
});
