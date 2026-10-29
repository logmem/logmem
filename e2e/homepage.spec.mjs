import { test, expect } from '@playwright/test';

test('client selection updates the connection guide and conversation example', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  for (const name of ['ChatGPT', 'Claude', 'Codex', 'Cursor', 'Gemini', 'Hermes', 'Muse']) {
    await page.locator('#agent-picker').getByRole('button', { name, exact: true }).click();
    await expect(page.locator('#preview-agent')).toHaveText('Your ' + name);
    await expect(page.locator('#preview-platform')).toContainText(name);
    await expect(page.locator('#setup-prompt')).toContainText(name);
    await expect(page.locator('#preview-note')).toContainText('Connect ' + name);
    await expect(page.locator('#preview-mascot')).toHaveAttribute('alt', name + ' logo');
    await expect(page.locator('#agent-instruction')).toContainText(name);
  }
  await expect(page.getByRole('list', { name: 'Guidance in the starting prompt' })).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.evaluate(() => document.documentElement.clientWidth));
  if (test.info().project.name === 'laptop') {
    const step = await page.locator('.steps article').first().boundingBox();
    const card = await page.locator('.setup-preview .phone-panel').boundingBox();
    expect(Math.abs(step.y - card.y)).toBeLessThanOrEqual(2);
  }
  await page.locator('#connect').scrollIntoViewIfNeeded();
  await page.locator('#connect').screenshot({ path: '/private/tmp/logmem-homepage-setup-' + test.info().project.name + '.png', animations: 'disabled', style: '.nav, .skip-link { visibility: hidden !important; }' });
  expect(errors).toEqual([]);
});

test('request invite reaches the real access form without a sign-in detour', async ({ page }) => {
  // Even an existing session must not override an explicit access request.
  await page.route('**/api/session', route => route.fulfill({ json: { user: { id: 'test-user' } } }));
  let submitted;
  await page.route('**/api/onboarding/waitlist', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Request invite' }).first().click();
  await expect(page.getByRole('heading', { name: 'What would you use it for?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Join the waitlist.', exact: true })).toBeVisible();
  await page.locator('#wl-email').fill('homepage-test@example.com');
  await page.getByRole('button', { name: 'Join the waitlist', exact: true }).click();
  await expect(page.locator('#wl-status')).toContainText('You’re on the waitlist.');
  expect(submitted.email).toBe('homepage-test@example.com');
});

test('pausing the example blocks its handoff and resuming restores it', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('switch', { name: 'Preview agent access' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#handoff-status')).toHaveText('Handoff blocked in this example');
  await expect(page.locator('#handoff-activity')).toContainText('cannot read');
  await expect(page.locator('.agent-state').first()).toHaveText('Paused');
  await expect(page.locator('#pause-note')).toContainText('No real agent or service changed');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#handoff-status')).toHaveText('Handoff ready');
  await expect(page.locator('.agent-state').first()).toHaveText('Active');
});
