import { test, expect } from '@playwright/test';

for (const tool of ['keys', 'connections']) {
  test(`${tool} keeps dashboard navigation and saved themes around its content`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (!localStorage.getItem('lm-app-theme')) localStorage.setItem('lm-app-theme', 'sage'); });
    await page.route('**/api/agent-keys', route => route.fulfill({ json: { spaces: ['example'], keys: [], web: [] } }));
    await page.route('**/api/connections', route => route.fulfill({ json: { email: 'test@example.com', plan: 'free', apps: [] } }));
    await page.goto('/' + tool + '?operator=1');
    await expect(page.locator('.lmx-utility-shell')).toBeVisible();
    await expect(page.getByRole('heading', { name: tool === 'keys' ? 'Agent keys' : 'Connected apps', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'sage');
    const nav = page.getByRole('navigation', { name: test.info().project.name === 'phone' ? 'Page navigation' : 'Dashboard navigation', exact: true });
    await expect(nav).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveAccessibleName(tool === 'keys' ? 'Agent keys' : 'Connections');
    if (test.info().project.name === 'phone') {
      const bounds = await nav.boundingBox();
      const active = await nav.locator('[aria-current="page"]').boundingBox();
      expect(active.x).toBeGreaterThanOrEqual(bounds.x);
      expect(active.x + active.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    await expect(page.getByRole('link', { name: 'Back to dashboard', exact: true }).last()).toHaveAttribute('href', '/app?operator=1');
    if (tool === 'keys') await page.getByLabel('Agent id', { exact: true }).fill('sample-agent');
    await page.getByRole('radio', { name: 'Midnight theme' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    if (tool === 'keys') await expect(page.getByLabel('Agent id', { exact: true })).toHaveValue('sample-agent');
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.evaluate(() => document.documentElement.clientWidth));
    await page.screenshot({ path: '/private/tmp/logmem-' + tool + '-shell-' + test.info().project.name + '.png', fullPage: true });
    await page.getByRole('radio', { name: 'Sand theme' }).check();
    const other = tool === 'keys' ? 'Connections' : 'Agent keys';
    await nav.getByRole('link', { name: other, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'sand');
    await expect(page.getByRole('heading', { name: tool === 'keys' ? 'Connected apps' : 'Agent keys', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('key creation still works after the shell moves the existing content', async ({ page }) => {
  let created;
  await page.route('**/api/agent-keys', route => {
    if (route.request().method() === 'POST') {
      created = route.request().postDataJSON();
      return route.fulfill({ json: { agent: created.agent, key: 'test-only-key-value' } });
    }
    return route.fulfill({ json: { spaces: ['example'], keys: [], web: [] } });
  });
  await page.goto('/keys');
  await page.getByLabel('Agent id', { exact: true }).fill('sample-agent');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New key', exact: true })).toContainText('test-only-key-value');
  expect(created).toMatchObject({ agent: 'sample-agent', space: 'example' });
  await page.getByRole('button', { name: 'Done, hide it', exact: true }).click();
  await expect(page.locator('#nk')).toHaveCount(0);
  await expect(page.locator('.lmx-utility-shell')).toBeVisible();
});

test('signed-out and failed states retain the frame', async ({ page }) => {
  await page.route('**/api/agent-keys', route => route.fulfill({ status: 401, json: { error: 'sign in required' } }));
  await page.goto('/keys');
  await expect(page.getByLabel('Admin password', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Theme', exact: true })).toBeVisible();
  await page.route('**/api/connections', route => route.fulfill({ status: 503, json: { error: 'Service unavailable' } }));
  await page.goto('/connections');
  await expect(page.getByRole('alert')).toHaveText('Service unavailable');
  await expect(page.getByRole('link', { name: 'Back to dashboard', exact: true }).last()).toBeVisible();
});
