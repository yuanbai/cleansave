import { afterEach, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyCounts, historySchema } from '@cleansave/contracts';
import { parseDouyin, parseKuaishou, parseYouTube } from '@cleansave/resolvers';
import { capture, fixtureBackend } from './helpers.js';

const instances: Awaited<ReturnType<typeof fixtureBackend>>[] = [];

afterEach(async () => {
  for (const backend of instances.splice(0)) {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('honors a duplicate download request made while resolution is running', async () => {
  const started = gate();
  const pending = gate();
  const b = await fixtureBackend({
    resolve: async () => {
      started.release();
      await pending.promise;
      return capture();
    },
  });
  instances.push(b);
  try {
    const first = await b.save();
    await started.promise;
    expect((await b.save(true, true)).recordId).toBe(first.recordId);
    pending.release();
    await b.settled();
    const record = await b.repo.get(first.recordId);
    expect(record.downloadState).toBe('complete');
    expect(record.assets).toHaveLength(1);
    expect((await b.repo.jobs()).find((job) => job.type === 'download')?.requireNoWatermark).toBe(
      true,
    );
    expect((await b.repo.history(record.id, historySchema.parse({}))).items).toHaveLength(1);
  } finally {
    pending.release();
  }
});

it('queues a duplicate download even while an independent metadata refresh is running', async () => {
  const started = gate();
  const pending = gate();
  let calls = 0;
  const b = await fixtureBackend({
    resolve: async () => {
      if (++calls === 2) {
        started.release();
        await pending.promise;
      }
      return capture();
    },
  });
  instances.push(b);
  try {
    const first = await b.save();
    await b.settled();
    await b.service(['read', 'write']).refresh(first.recordId);
    await started.promise;
    await b.save(true);
    pending.release();
    await b.settled();
    expect((await b.repo.get(first.recordId)).downloadState).toBe('complete');
    expect((await b.repo.history(first.recordId, historySchema.parse({}))).items).toHaveLength(2);
  } finally {
    pending.release();
  }
});

it('uses the latest duplicate policy and reuses previously resolved aliases without resolving again', async () => {
  const started = gate();
  const pending = gate();
  let calls = 0;
  const b = await fixtureBackend({
    resolve: async () => {
      calls++;
      if (calls === 1) {
        started.release();
        await pending.promise;
      }
      return capture({ clean: false });
    },
  });
  instances.push(b);
  try {
    const first = await b.save(true, true);
    await started.promise;
    await b.save(true, false);
    pending.release();
    await b.settled();
    expect((await b.repo.get(first.recordId)).downloadState).toBe('complete');
    expect((await b.repo.jobs()).find((job) => job.type === 'download')?.requireNoWatermark).toBe(
      false,
    );
    const alias = 'https://v.douyin.com/known-alias/';
    await b.save(false, false, alias);
    await b.settled();
    const priorCalls = calls;
    expect((await b.save(false, false, alias)).recordId).toBe(first.recordId);
    await b.settled();
    expect(calls).toBe(priorCalls);
  } finally {
    pending.release();
  }
});

it('keeps an independent count refresh valid when its concurrent download is cancelled', async () => {
  const downloading = gate();
  const refreshing = gate();
  const pending = gate();
  let calls = 0;
  const b = await fixtureBackend({
    resolve: async () => {
      const call = ++calls;
      if (call === 2) {
        downloading.release();
        await pending.promise;
      }
      if (call === 3) {
        refreshing.release();
        await pending.promise;
      }
      return capture({ title: call === 3 ? 'Refreshed title' : 'Initial title' });
    },
  });
  instances.push(b);
  try {
    const saved = await b.save(true);
    await downloading.promise;
    await b.service(['read', 'write']).refresh(saved.recordId);
    await refreshing.promise;
    const job = (await b.repo.jobs()).find((job) => job.type === 'download');
    if (!job) throw new Error('Missing download');
    await b.worker.cancel(job.id);
    pending.release();
    await b.settled();
    const record = await b.repo.get(saved.recordId);
    expect(record.downloadState).toBe('cancelled');
    expect(record.metadata?.title).toBe('Refreshed title');
    expect(record.refreshError).toBeNull();
    expect((await b.repo.history(record.id, historySchema.parse({}))).items).toHaveLength(2);
  } finally {
    pending.release();
  }
});

it('restarts unsuccessful resolution when a duplicate explicitly requests a download', async () => {
  const b = await fixtureBackend();
  instances.push(b);
  await b.worker.stop();
  const saved = await b.repo.create(
    {
      input: 'fixture',
      url: 'https://www.douyin.com/video/12345',
      platform: 'douyin',
      downloadContent: false,
      requireNoWatermark: false,
    },
    null,
  );
  if (!saved.jobId) throw new Error('Missing job');
  await b.repo.cancel(saved.jobId);
  const duplicate = await b.save(true);
  expect(duplicate.recordId).toBe(saved.recordId);
  expect(duplicate.jobId).not.toBe(saved.jobId);
  expect((await b.repo.getJob(duplicate.jobId)).type).toBe('resolve');
  expect((await b.repo.get(saved.recordId)).options.downloadContent).toBe(true);
});

it('preserves the previous metadata and count series when a refresh returns partial fallback metadata', async () => {
  let calls = 0;
  const b = await fixtureBackend({
    resolve: async () => {
      const value = capture();
      return ++calls === 1
        ? value
        : {
            ...value,
            sources: [],
            counts: emptyCounts(),
            metadata: {
              ...value.metadata,
              title: 'Partial fallback',
              warnings: ['partial_metadata'],
            },
            accessError: {
              code: 'platform_verification_required',
              message: 'Access requires verification.',
              retryable: false,
            },
          };
    },
  });
  instances.push(b);
  const first = await b.save();
  await b.settled();
  const before = await b.repo.get(first.recordId);
  await b.service(['read', 'write']).refresh(first.recordId);
  await b.settled();
  const after = await b.repo.get(first.recordId);
  expect(after.metadata).toEqual(before.metadata);
  expect(after.counts).toEqual(before.counts);
  expect(after.refreshError?.code).toBe('platform_verification_required');
  expect((await b.repo.history(after.id, historySchema.parse({}))).items).toHaveLength(1);
});

it('redownloads files removed or truncated while the backend is running without recapturing metadata', async () => {
  const b = await fixtureBackend();
  instances.push(b);
  const saved = await b.save(true);
  await b.settled();
  const original = await b.repo.get(saved.recordId);
  for (const damage of ['remove', 'truncate']) {
    const record = await b.repo.get(saved.recordId);
    const asset = record.assets.find((asset) => asset.state === 'complete');
    if (!asset) throw new Error('Missing fixture asset');
    const entry = await b.repo.assetPath(asset.id);
    const path = join(b.root, entry.relativePath);
    if (damage === 'remove') await rm(path);
    else await writeFile(path, 'truncated');
    await b.service(['read', 'write']).download(record.id);
    await b.settled();
    const repaired = await b.repo.get(record.id);
    expect(repaired.downloadState).toBe('complete');
    expect(repaired.assets.find((value) => value.id === asset.id)?.state).toBe('missing_on_disk');
    expect(repaired.assets.filter((value) => value.state === 'complete')).toHaveLength(1);
    expect(repaired.metadata).toEqual(original.metadata);
  }
  expect((await b.repo.history(saved.recordId, historySchema.parse({}))).items).toHaveLength(1);
});

it('does not allow cancellation to strand a record after destructive cleanup has been queued', async () => {
  const b = await fixtureBackend();
  instances.push(b);
  const saved = await b.save(true);
  await b.settled();
  await b.worker.stop();
  const remove = await b.repo.enqueue(saved.recordId, 'remove_downloads');
  await expect(b.repo.cancel(remove.id)).rejects.toMatchObject({ code: 'job_not_cancellable' });
  const deleting = await b.repo.enqueue(saved.recordId, 'delete');
  await expect(b.repo.cancel(deleting.id)).rejects.toMatchObject({ code: 'job_not_cancellable' });
});

it('cancelling resolution also clears pending automatic download state', async () => {
  const b = await fixtureBackend();
  instances.push(b);
  await b.worker.stop();
  const saved = await b.repo.create(
    {
      input: 'fixture',
      url: 'https://www.douyin.com/video/12345',
      platform: 'douyin',
      downloadContent: true,
      requireNoWatermark: false,
    },
    null,
  );
  if (!saved.jobId) throw new Error('Missing resolution job');
  await b.repo.cancel(saved.jobId);
  expect((await b.repo.get(saved.recordId)).downloadState).toBe('cancelled');
});

it('keeps identifying query parameters in canonical links while removing share tracking', () => {
  expect(
    parseYouTube(
      { videoDetails: { videoId: 'abcdefghijk' } },
      'abcdefghijk',
      'https://www.youtube.com/watch?v=abcdefghijk&si=tracking',
    )?.metadata.canonicalUrl,
  ).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  expect(
    parseDouyin(
      { aweme_id: '123', video: {} },
      '123',
      'https://www.douyin.com/?modal_id=123&tracking=yes',
    )?.metadata.canonicalUrl,
  ).toBe('https://www.douyin.com/?modal_id=123');
  expect(
    parseKuaishou(
      { photoId: '123', manifest: {} },
      ['123'],
      'https://www.kuaishou.com/?photoId=123&tracking=yes',
    )?.metadata.canonicalUrl,
  ).toBe('https://www.kuaishou.com/?photoId=123');
});

it('returns client errors for malformed JSON and oversized requests without leaking input', async () => {
  const b = await fixtureBackend();
  instances.push(b);
  for (const [payload, status] of [
    ['{"input":', 400],
    [JSON.stringify({ input: 'x'.repeat(70000) }), 413],
  ] as const) {
    const response = await b.app.inject({
      method: 'POST',
      url: '/api/v1/records',
      headers: { ...b.headers, 'content-type': 'application/json' },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.retryable).toBe(false);
    expect(response.body).not.toContain(payload);
  }
});
