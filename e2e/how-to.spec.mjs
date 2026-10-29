import { test, expect } from '@playwright/test';

test('/how-to: the seed prompt shows, switches to the software version, and copies', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/how-to');
  await expect(page.getByRole('heading', { name: 'How to use LogMem.' })).toBeVisible();
  const box = page.locator('#seed-prompt');
  await expect(box).toContainText('Seed my LogMem space for one project');
  await expect(box).not.toContainText('Developer sources');
  await page.getByRole('button', { name: 'For a software project' }).click();
  await expect(box).toContainText('Developer sources');
  await page.getByRole('button', { name: 'Copy seed prompt' }).click();
  await expect(page.getByText('Copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Developer sources');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the header links to How to use on a public page', async ({ page }) => {
  await page.goto('/pricing');
  const link = page.locator('header.nav a[href="/how-to"]').first();
  await expect(link).toHaveCount(1);
});
