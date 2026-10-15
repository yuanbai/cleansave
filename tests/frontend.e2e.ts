import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

test('library, add options/ambiguity, duplicate reuse, refresh counts and protected draft', async ({
  page,
}) => {
  const runtime = z
    .object({ pairingSecret: z.string() })
    .parse(JSON.parse(await readFile('.test-runtime.json', 'utf8')));
  await page.goto('/#pair=' + runtime.pairingSecret);
  await expect(page.getByRole('heading', { name: 'Your library starts here' })).toBeVisible();
  expect(page.url()).not.toContain('#');
  await page.getByRole('link', { name: 'Add link' }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Download content' })).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Only sources marked watermark-free' }),
  ).not.toBeChecked();
  await page
    .getByLabel('Paste a link or share message')
    .fill('Share https://www.douyin.com/video/12345 https://www.youtube.com/watch?v=abcdefghijk');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByText('Choose one link')).toBeVisible();
  await page.getByRole('radio', { name: /douyin/ }).check();
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture landscape', exact: true })).toBeVisible();
  const original = new URL(page.url()).pathname;
  await expect(page.getByText('Media has not been downloaded')).toBeVisible();
  await page.getByLabel('Personal notes', { exact: true }).fill('Unsaved browser draft');
  await page.getByRole('button', { name: 'Refresh metadata' }).click();
  await expect(
    page.getByRole('heading', { name: 'Updated fixture landscape', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Personal notes', { exact: true })).toHaveValue(
    'Unsaved browser draft',
  );
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('img', { name: /Likes/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save notes & tags' }).click();
  await expect(page.getByText('Edits saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download missing media' }).click();
  await expect(page.locator('img[alt="Images 1"]')).toBeVisible();
  await page.getByRole('link', { name: 'Add link', exact: true }).click();
  await page.getByLabel('Paste a link or share message').fill('https://www.douyin.com/video/12345');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(
    page.getByText('This post was already saved. Opened the existing record.'),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(original);
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByLabel('Personal notes', { exact: true })).toHaveValue(
    'Unsaved browser draft',
  );
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByLabel('Search your library').fill('Updated fixture');
  await expect(page.getByRole('heading', { name: 'Updated fixture landscape' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('failed refresh keeps prior count history and note draft', async ({ page }) => {
  const runtime = z
    .object({ token: z.string() })
    .parse(JSON.parse(await readFile('.test-runtime.json', 'utf8')));
  // A real scoped token bypasses pairing only in this isolated browser context; no production auth bypass.
  await page.setExtraHTTPHeaders({ authorization: 'Bearer ' + runtime.token });
  await page.request.patch('/api/v1/settings', {
    headers: { authorization: 'Bearer ' + runtime.token },
    data: { theme: 'system', language: 'en', downloadContent: false, requireNoWatermark: false },
  });
  await page.goto('/add');
  await page.getByLabel('Paste a link or share message').fill('https://www.douyin.com/video/999');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture landscape', exact: true })).toBeVisible();
  await page.getByLabel('Personal notes', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Refresh metadata' }).click();
  await expect(page.getByText('Fixture refresh unavailable.')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByLabel('Personal notes', { exact: true })).toHaveValue('Keep this draft');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
