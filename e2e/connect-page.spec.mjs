import { test, expect } from '@playwright/test';

test('/connect: pick an AI, see its clicks and its prompt, copy the link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/connect');
  await expect(page.getByRole('heading', { name: 'Connect your AI to LogMem.' })).toBeVisible();
  await expect(page.locator('.client-panel[data-client="Claude"]')).toBeVisible();
  await expect(page.locator('.client-panel[data-client="Cursor"]')).toBeHidden();
  await page.getByRole('button', { name: 'Cursor' }).click();
  await expect(page.locator('.client-panel[data-client="Cursor"]')).toBeVisible();
  await expect(page.locator('.client-panel[data-client="Claude"]')).toBeHidden();
  await expect(page.locator('#prompt-cursor')).toContainText('Help me set up Cursor in my LogMem space.');
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Copied.').first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://logmem.si/mcp');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('/connect without JavaScript still shows the link and a prompt', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/connect');
  await expect(page.locator('#mcp-url')).toHaveText('https://logmem.si/mcp');
  await expect(page.locator('#prompt-claude')).toContainText('Help me set up Claude in my LogMem space.');
  await ctx.close();
});
