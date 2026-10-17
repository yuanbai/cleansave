import { test, expect } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { acceptedSchema, recordSchema } from '@cleansave/contracts';
import { settingsSchema } from '@cleansave/client';
import { AppError } from '@cleansave/core';
import { capture, fixtureBackend, image } from './helpers.js';

test('library, add options/ambiguity, duplicate reuse, refresh counts and protected draft', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No saved records' })).toBeVisible();
  expect(page.url()).not.toContain('#');
  expect(
    (await page.context().cookies()).some((cookie) => cookie.name === 'cleansave_session'),
  ).toBe(false);
  await page.getByRole('link', { name: 'Add link' }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Download content' })).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Only sources marked watermark-free' }),
  ).toHaveCount(0);
  await page
    .getByLabel('Paste a link or share message')
    .fill('Share https://www.douyin.com/video/12345 https://www.youtube.com/watch?v=abcdefghijk');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByText('Choose one link')).toBeVisible();
  await page.getByRole('radio', { name: /douyin/ }).check();
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(
    page.getByRole('region', { name: 'Post details' }).getByText('Test author', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Counts', exact: true })).toBeVisible();
  const original = new URL(page.url()).pathname;
  const saved = recordSchema.parse(await (await page.request.get('/api/v1' + original)).json());
  expect(saved.options.requireNoWatermark).toBe(true);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
  await expect(page.getByText('Media has not been downloaded')).toBeVisible();
  const downloadPanel = page.getByRole('region', { name: 'Download content', exact: true });
  const removeDownloads = downloadPanel.getByRole('button', {
    name: 'Remove downloads',
    exact: true,
  });
  const deleteRecord = page
    .getByRole('region', { name: 'Post details', exact: true })
    .getByRole('button', { name: 'Delete record', exact: true });
  await expect(deleteRecord).toBeVisible();
  await expect(removeDownloads).toHaveCount(0);
  await page.getByLabel('Personal notes', { exact: true }).fill('Unsaved browser draft');
  await page.getByRole('button', { name: 'Refresh metadata' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByLabel('Personal notes', { exact: true })).toHaveValue(
    'Unsaved browser draft',
  );
  await expect(page.getByRole('img', { name: /Likes/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save notes & tags' }).click();
  await expect(page.getByText('Edits saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download missing media' }).click();
  await expect(page.locator('img[alt="Images 1"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download missing media' })).toHaveCount(0);
  await expect(removeDownloads).toBeVisible();
  await expect(downloadPanel.getByText(/^SHA-256 /)).toBeVisible();
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
  await removeDownloads.click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download missing media' })).toBeVisible();
  await expect(removeDownloads).toHaveCount(0);
  await deleteRecord.click();
  await expect(page.getByRole('heading', { name: 'Delete record', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByLabel('Search your library').fill('Updated fixture');
  await expect(page.getByRole('heading', { name: 'Updated fixture landscape' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await expect(page.getByLabel('Appearance', { exact: true }).locator('option')).toHaveText([
    'System',
    'Light',
    'Dark',
  ]);
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('外观', { exact: true }).locator('option')).toHaveText([
    '系统',
    '浅色',
    '深色',
  ]);
  await expect(page.getByLabel('外观', { exact: true })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('all preferences apply immediately, persist and recover from save failures', async ({
  page,
}) => {
  let persisted = settingsSchema.parse({});
  await page.request.patch('/api/v1/settings', { data: persisted });
  await page.goto('/settings');
  const downloadDefault = page.getByRole('checkbox');
  await expect(page.getByRole('button', { name: /^(Save preferences|保存设置)$/ })).toHaveCount(0);
  let releaseSave = (): void => {};
  let notifySave = (): void => {};
  let saveGate = Promise.resolve();
  let failNextSave = false;
  await page.route('**/api/v1/settings', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    notifySave();
    await saveGate;
    if (failNextSave) {
      failNextSave = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'settings_unavailable',
            message: 'Fixture settings unavailable.',
            retryable: true,
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  for (const choice of [
    {
      change: () => page.getByLabel('Appearance', { exact: true }).selectOption('dark'),
      theme: 'dark',
      language: 'en',
      downloadContent: false,
    },
    {
      change: () => page.getByLabel('Language', { exact: true }).selectOption('zh-CN'),
      theme: 'dark',
      language: 'zh-CN',
      downloadContent: false,
    },
    {
      change: () => downloadDefault.check(),
      theme: 'dark',
      language: 'zh-CN',
      downloadContent: true,
    },
  ]) {
    saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifySave = resolve;
    });
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/settings' &&
        response.request().method() === 'PATCH',
    );
    try {
      await choice.change();
      await started;
      await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
      await expect(page.locator('html')).toHaveAttribute('lang', choice.language);
      if (choice.downloadContent) {
        await expect(downloadDefault).toBeChecked();
      } else {
        await expect(downloadDefault).not.toBeChecked();
      }
      await expect(downloadDefault).toBeDisabled();
      await expect(page.getByRole('combobox').nth(0)).toBeDisabled();
      await expect(page.getByRole('combobox').nth(1)).toBeDisabled();
      expect(
        settingsSchema.parse(await (await page.request.get('/api/v1/settings')).json()),
      ).toEqual(persisted);
    } finally {
      releaseSave();
    }
    const result = await saved;
    expect(result.status()).toBe(200);
    persisted = settingsSchema.parse(await result.json());
    expect(persisted).toEqual({
      downloadContent: choice.downloadContent,
      requireNoWatermark: false,
      theme: choice.theme,
      language: choice.language,
    });
    await expect(
      page.getByLabel(choice.language === 'zh-CN' ? '外观' : 'Appearance', { exact: true }),
    ).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: /^(Save preferences|保存设置)$/ })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(downloadDefault).toBeChecked();
  saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const failedSaveStarted = new Promise<void>((resolve) => {
    notifySave = resolve;
  });
  failNextSave = true;
  try {
    await downloadDefault.uncheck();
    await failedSaveStarted;
    await expect(downloadDefault).not.toBeChecked();
  } finally {
    releaseSave();
  }
  await expect(page.getByRole('alert')).toHaveText('Fixture settings unavailable.');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByLabel('外观', { exact: true })).toHaveValue('dark');
  await expect(downloadDefault).toBeChecked();
  expect(settingsSchema.parse(await (await page.request.get('/api/v1/settings')).json())).toEqual(
    persisted,
  );
  const retriedSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/settings' &&
      response.request().method() === 'PATCH',
  );
  await downloadDefault.uncheck();
  expect((await retriedSave).status()).toBe(200);
  await expect(downloadDefault).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(downloadDefault).not.toBeChecked();
  await page.goto('/add');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.request.patch('/api/v1/settings', { data: settingsSchema.parse({}) });
});

test('settings storage updates after downloads and removal and follows the selected language', async ({
  page,
}) => {
  const backend = await fixtureBackend(undefined, { port: 4794, webRoot: resolve('dist/web') });
  const base = 'http://127.0.0.1:4794';
  try {
    await backend.app.listen({ host: '127.0.0.1', port: 4794 });
    await page.goto(base + '/settings');
    const storage = page.getByRole('region', { name: 'Storage', exact: true });
    await expect(storage.getByLabel('Downloaded media', { exact: true })).toHaveText('0 B');
    await expect(storage.getByLabel('Downloaded files', { exact: true })).toHaveText('0');
    // Download through a separate client while Settings stays open. SSE invalidation should
    // update the total without navigating, reloading, or changing any preferences.
    const saved = acceptedSchema.parse(
      await (
        await page.request.post(base + '/api/v1/records', {
          data: { input: 'https://www.douyin.com/video/12345', downloadContent: true },
        })
      ).json(),
    );
    await expect(storage.getByLabel('Downloaded media', { exact: true })).toHaveText(
      image.length + ' B',
    );
    await expect(storage.getByLabel('Downloaded files', { exact: true })).toHaveText('1');
    const removed = await page.request.delete(base + `/api/v1/records/${saved.recordId}/downloads`);
    expect(removed.status()).toBe(202);
    await expect(storage.getByLabel('Downloaded media', { exact: true })).toHaveText('0 B');
    await expect(storage.getByLabel('Downloaded files', { exact: true })).toHaveText('0');
    await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
    const localized = page.getByRole('region', { name: '存储空间', exact: true });
    await expect(localized.getByLabel('已下载媒体', { exact: true })).toHaveText('0 B');
    await expect(localized.getByLabel('已下载文件数', { exact: true })).toHaveText('0');
    await page.reload();
    await expect(localized.getByLabel('已下载媒体', { exact: true })).toHaveText('0 B');
  } finally {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});

test('web downloads and retries require clean sources despite legacy API policies', async ({
  page,
}) => {
  const attempts = new Map<string, number>();
  const backend = await fixtureBackend(
    {
      resolve: async (url) => {
        const id = new URL(url).pathname.split('/').at(-1) ?? '';
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (['8103', '8104'].includes(id) && attempt === 1)
          throw new AppError('network_unavailable', 'Fixture resolution unavailable.', 422);
        return capture({ id, clean: false });
      },
    },
    {
      port: 4796,
      webRoot: resolve('dist/web'),
      fetchMedia: async () => {
        throw new AppError('network_unavailable', 'Fixture download unavailable.', 422);
      },
    },
  );
  try {
    await backend.app.listen({ host: '127.0.0.1', port: 4796 });
    for (const scenario of [
      { id: '8101', action: 'download' },
      { id: '8102', action: 'retry-download' },
      { id: '8103', action: 'resolve' },
      { id: '8104', action: 'retry-resolve' },
    ]) {
      const response = await page.request.post('http://127.0.0.1:4796/api/v1/records', {
        data: {
          input: 'https://www.douyin.com/video/' + scenario.id,
          downloadContent: scenario.action !== 'download',
          requireNoWatermark: false,
        },
      });
      expect(response.status()).toBe(202);
      const { recordId } = acceptedSchema.parse(await response.json());
      await backend.settled();
      expect((await backend.repo.get(recordId)).options.requireNoWatermark).toBe(false);
      if (scenario.action.startsWith('retry-')) {
        await page.goto('http://127.0.0.1:4796/activity');
        const row = page
          .locator('section')
          .filter({ has: page.locator(`a[href="/records/${recordId}"]`) })
          .filter({ has: page.getByRole('button', { name: 'Retry', exact: true }) });
        await row.getByRole('button', { name: 'Retry', exact: true }).click();
      } else {
        await page.goto('http://127.0.0.1:4796/records/' + recordId);
        await page
          .getByRole('button', {
            name: scenario.action === 'download' ? 'Download missing media' : 'Retry resolution',
          })
          .click();
      }
      await expect
        .poll(async () => (await backend.repo.get(recordId)).error?.code)
        .toBe('clean_source_unavailable');
      await backend.settled();
      const record = await backend.repo.get(recordId);
      expect(record.assets).toHaveLength(0);
      const latestDownload = (await backend.repo.jobs()).find(
        (job) => job.recordId === recordId && job.type === 'download',
      );
      expect(latestDownload?.requireNoWatermark).toBe(true);
      expect(
        (await backend.repo.history(recordId, { order: 'asc', limit: 30 })).items,
      ).toHaveLength(1);
    }
  } finally {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});

test('failed refresh keeps prior count history and note draft', async ({ page }) => {
  const runtime = z
    .object({ token: z.string() })
    .parse(JSON.parse(await readFile('.test-runtime.json', 'utf8')));
  // Explicit tokens continue to use their configured scopes in the default local mode.
  await page.setExtraHTTPHeaders({ authorization: 'Bearer ' + runtime.token });
  await page.request.patch('/api/v1/settings', {
    headers: { authorization: 'Bearer ' + runtime.token },
    data: { theme: 'system', language: 'en', downloadContent: false, requireNoWatermark: false },
  });
  await page.goto('/add');
  await page.getByLabel('Paste a link or share message').fill('https://www.douyin.com/video/999');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(
    page.getByRole('region', { name: 'Post details' }).getByText('Test author', { exact: true }),
  ).toBeVisible();
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

test.describe('count window presets', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });

  test('presets fill the date fields and preserve the chart and page position', async ({
    page,
  }) => {
    await page.request.patch('/api/v1/settings', {
      data: { theme: 'system', language: 'en', downloadContent: false, requireNoWatermark: false },
    });
    const response = await page.request.post('/api/v1/records', {
      data: { input: 'https://www.douyin.com/video/555', requireNoWatermark: true },
    });
    expect(response.status()).toBe(202);
    const { recordId } = acceptedSchema.parse(await response.json());
    await page.goto('/records/' + recordId);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: 'Refresh metadata', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    const fromField = page.getByLabel('From', { exact: true });
    const toField = page.getByLabel('Until (exclusive)', { exact: true });
    const countWindow = page.getByLabel('Count window');
    await expect(page.getByRole('button', { name: 'Apply window', exact: true })).toHaveCount(0);
    let releaseResponse = (): void => {};
    let notifyRequest = (): void => {};
    let responseGate = Promise.resolve();
    let historyRequests = 0;
    await page.route('**/counts/history?*', async (route) => {
      historyRequests++;
      if (new URL(route.request().url()).searchParams.has('from')) {
        notifyRequest();
        await responseGate;
      }
      await route.continue();
    });
    for (const days of ['7', '30', '7']) {
      responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const started = new Promise<void>((resolve) => {
        notifyRequest = resolve;
      });
      const received = page.waitForResponse((result) => {
        const url = new URL(result.url());
        return url.pathname.endsWith('/counts/history') && url.searchParams.has('from');
      });
      // Keep the controls visible near the bottom, where a collapsed panel clamps page scrolling.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const before = await page.evaluate(() => ({
        y: window.scrollY,
        height: document.documentElement.scrollHeight,
      }));
      const selectedAt = Date.now();
      try {
        await countWindow.selectOption(days);
        await started;
        await expect(
          page.getByRole('img', { name: 'Likes · Counts over time', exact: true }),
        ).toBeVisible();
        await expect(page.locator('tbody tr')).toHaveCount(2);
        await expect(page.getByRole('status')).toHaveText('Loading…');
        const during = await page.evaluate(() => ({
          y: window.scrollY,
          height: document.documentElement.scrollHeight,
        }));
        expect(Math.abs(during.y - before.y)).toBeLessThan(2);
        expect(during.height).toBe(before.height);
      } finally {
        releaseResponse();
        expect((await received).status()).toBe(200);
      }
      await expect(fromField).not.toHaveValue('');
      await expect(toField).not.toHaveValue('');
      const displayed = await page.evaluate(
        ({ from, to }) => ({
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        }),
        { from: await fromField.inputValue(), to: await toField.inputValue() },
      );
      const params = new URL((await received).url()).searchParams;
      expect(params.get('from')).toBe(displayed.from);
      expect(params.get('to')).toBe(displayed.to);
      expect(Date.parse(displayed.to) - Date.parse(displayed.from)).toBe(Number(days) * 86_400_000);
      expect(Date.parse(displayed.to)).toBeGreaterThanOrEqual(selectedAt);
      expect(Date.parse(displayed.to)).toBeLessThanOrEqual(Date.now() + 60_000);
      await expect(page.locator('tbody tr')).toHaveCount(2);
      await expect(page.getByRole('status')).toHaveCount(0);
      const after = await page.evaluate(() => ({
        y: window.scrollY,
        height: document.documentElement.scrollHeight,
      }));
      expect(Math.abs(after.y - before.y)).toBeLessThan(2);
      expect(after.height).toBe(before.height);
    }
    const presetEnd = await page.evaluate(
      (value) => new Date(value).toISOString(),
      await toField.inputValue(),
    );
    for (const edit of [
      {
        field: fromField,
        value: '2100-01-01T00:00',
        from: '2099-12-31T16:00:00.000Z',
        to: presetEnd,
        range: 'custom',
        rows: 2,
        invalid: true,
      },
      {
        field: fromField,
        value: '2020-01-01T00:00',
        from: '2019-12-31T16:00:00.000Z',
        to: presetEnd,
        range: 'custom',
        rows: 2,
      },
      {
        field: toField,
        value: '2019-01-01T00:00',
        from: '2019-12-31T16:00:00.000Z',
        to: '2018-12-31T16:00:00.000Z',
        range: 'custom',
        rows: 2,
        invalid: true,
      },
      {
        field: toField,
        value: '2020-01-02T00:00',
        from: '2019-12-31T16:00:00.000Z',
        to: '2020-01-01T16:00:00.000Z',
        range: 'custom',
        rows: 0,
      },
      {
        field: toField,
        value: '2020-01-01T00:00',
        from: '2019-12-31T16:00:00.000Z',
        to: '2019-12-31T16:00:00.000Z',
        range: 'custom',
        rows: 0,
        invalid: true,
      },
      {
        field: toField,
        value: '',
        from: '2019-12-31T16:00:00.000Z',
        to: null,
        range: 'custom',
        rows: 2,
      },
      { field: fromField, value: '', from: null, to: null, range: 'all', rows: 2 },
      {
        field: toField,
        value: '2020-01-02T00:00',
        from: null,
        to: '2020-01-01T16:00:00.000Z',
        range: 'custom',
        rows: 0,
      },
      { field: toField, value: '', from: null, to: null, range: 'all', rows: 2 },
    ]) {
      const previousRequests = historyRequests;
      const chart = page.getByRole('img', { name: 'Likes · Counts over time', exact: true });
      const previousChart = edit.invalid && (await chart.count()) ? await chart.innerHTML() : null;
      const previousRows = edit.invalid ? await page.locator('tbody tr').allTextContents() : null;
      const received = edit.invalid
        ? undefined
        : page.waitForResponse((result) => {
            const url = new URL(result.url());
            return (
              url.pathname.endsWith('/counts/history') &&
              url.searchParams.get('from') === edit.from &&
              url.searchParams.get('to') === edit.to
            );
          });
      await edit.field.fill(edit.value);
      await expect(countWindow).toHaveValue(edit.range);
      await expect(countWindow.locator('option:checked')).toHaveText(
        edit.range === 'all' ? 'All time' : 'Custom range',
      );
      if (received) {
        expect((await received).status()).toBe(200);
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(fromField).not.toHaveAttribute('aria-invalid', 'true');
        await expect(toField).not.toHaveAttribute('aria-invalid', 'true');
      } else {
        await expect(page.getByRole('alert')).toHaveText(
          'From must be earlier than Until. Showing the last valid range.',
        );
        await expect(fromField).toHaveAttribute('aria-invalid', 'true');
        await expect(toField).toHaveAttribute('aria-invalid', 'true');
        if (previousChart === null) {
          await expect(chart).toHaveCount(0);
        } else {
          expect(await chart.innerHTML()).toBe(previousChart);
        }
        expect(await page.locator('tbody tr').allTextContents()).toEqual(previousRows);
        expect(historyRequests).toBe(previousRequests);
      }
      await expect(page.locator('tbody tr')).toHaveCount(edit.rows);
      if (edit.rows === 0) {
        await expect(
          page.getByText('No captures in this time window', { exact: true }),
        ).toBeVisible();
      }
    }
    const preset = page.waitForResponse((result) => {
      const url = new URL(result.url());
      return url.pathname.endsWith('/counts/history') && url.searchParams.has('from');
    });
    await countWindow.selectOption('30');
    expect((await preset).status()).toBe(200);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await toField.fill('1900-01-01T00:00');
    await expect(page.getByRole('alert')).toBeVisible();
    const allTime = page.waitForResponse((result) => {
      const url = new URL(result.url());
      return (
        url.pathname.endsWith('/counts/history') &&
        !url.searchParams.has('from') &&
        !url.searchParams.has('to')
      );
    });
    await countWindow.selectOption('all');
    expect((await allTime).status()).toBe(200);
    await expect(fromField).toHaveValue('');
    await expect(toField).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('tbody tr')).toHaveCount(2);
  });
});

test('post details show a single caption with a four-line expandable preview', async ({ page }) => {
  await page.request.patch('/api/v1/settings', {
    data: { theme: 'system', language: 'en', downloadContent: false, requireNoWatermark: false },
  });
  const response = await page.request.post('/api/v1/records', {
    data: { input: 'https://www.douyin.com/video/777', requireNoWatermark: true },
  });
  expect(response.status()).toBe(202);
  const { recordId } = acceptedSchema.parse(await response.json());
  await page.goto('/records/' + recordId);
  await expect(page.getByRole('heading', { name: 'Post details', level: 1 })).toBeVisible();
  const details = page.getByRole('region', { name: 'Post details' });
  await expect(details.getByText('Test author', { exact: true })).toBeVisible();
  await expect(details.getByText('douyin', { exact: true })).toBeVisible();
  const caption = page.locator('p').filter({ hasText: 'Caption line 1:' });
  await expect(caption).toHaveCount(1);
  const more = page.getByRole('button', { name: 'Show more', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  const preview = await caption.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(window.getComputedStyle(element).lineHeight),
  }));
  expect(preview.height).toBeCloseTo(preview.lineHeight * 4, 0);
  await more.click();
  const less = page.getByRole('button', { name: 'Show less', exact: true });
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  expect(
    await caption.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThan(preview.height);
  await less.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(more).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto('/settings');
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('语言', { exact: true })).toBeEnabled();
  await page.goto('/records/' + recordId);
  await expect(page.getByRole('heading', { name: '帖子详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开全文', exact: true }).click();
  await expect(page.getByRole('button', { name: '收起', exact: true })).toBeVisible();
  await page.request.patch('/api/v1/settings', {
    data: { theme: 'system', language: 'en', downloadContent: false, requireNoWatermark: false },
  });
});

test('a fresh browser context can reopen the library without a pairing link or cookies', async ({
  browser,
}) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:4788/#pair=stale-unused-link');
      await expect(page.getByRole('link', { name: 'Add link', exact: true }).first()).toBeVisible();
      expect(page.url()).not.toContain('#');
      expect((await context.cookies()).some((cookie) => cookie.name === 'cleansave_session')).toBe(
        false,
      );
    } finally {
      await context.close();
    }
  }
});

test('optional pairing still requires a one-use link before browser access', async ({ page }) => {
  const backend = await fixtureBackend(undefined, {
    port: 4795,
    requirePairing: true,
    webRoot: resolve('dist/web'),
  });
  try {
    await backend.app.listen({ host: '127.0.0.1', port: 4795 });
    await page.goto('http://127.0.0.1:4795/');
    await expect(
      page.getByRole('heading', { name: 'Connect to your local library' }),
    ).toBeVisible();
    await page.goto('http://127.0.0.1:4795/#pair=' + backend.auth.pairingSecret);
    await expect(page.getByRole('heading', { name: 'No saved records' })).toBeVisible();
    expect(page.url()).not.toContain('#');
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === 'cleansave_session'),
    ).toBe(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'No saved records' })).toBeVisible();
    await page.context().clearCookies();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Connect to your local library' }),
    ).toBeVisible();
  } finally {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});
