import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { SqliteRepository, FileStore } from '@cleansave/storage';
import { AppError } from '@cleansave/core';
import { historySchema } from '@cleansave/contracts';
import { capture, fixtureBackend, image } from './helpers.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), 'cleansave-recovery-'));
  roots.push(result);
  return result;
}
it('reconciles a renamed file after a crash, requeues interrupted jobs and marks later missing files', async () => {
  const directory = await root();
  let repo = await SqliteRepository.open(directory);
  try {
    await expect(SqliteRepository.open(directory)).rejects.toMatchObject({
      code: 'library_in_use',
    });
    const accepted = await repo.create(
      {
        input: 'fixture',
        url: 'https://www.douyin.com/video/12345',
        platform: 'douyin',
        downloadContent: false,
        requireNoWatermark: false,
      },
      null,
    );
    const resolution = await repo.claim();
    if (!resolution) throw new Error('Missing job');
    await repo.capture(resolution, capture());
    await repo.updateJob({ ...resolution, state: 'succeeded' });
    const downloading = await repo.enqueue(accepted.recordId, 'download');
    const job = await repo.claim();
    if (!job) throw new Error('Missing download');
    const record = await repo.get(accepted.recordId);
    const files = new FileStore(
      directory,
      async (url) => ({ url, body: Readable.from(image), status: 200, headers: {} }),
      (id) => repo.get(id),
    );
    const source = capture().sources[0];
    if (!source) throw new Error('Missing source');
    const retained = await files.retain(
      job,
      record,
      source,
      new AbortController().signal,
      () => {},
    );
    await expect(
      repo.finalize(job, retained.asset, retained.relativePath, async () => {
        await retained.adopt();
        throw new Error('Simulated power loss after rename');
      }),
    ).rejects.toThrow('Simulated');
    await repo.close();
    repo = await SqliteRepository.open(directory);
    const recovered = await repo.get(accepted.recordId);
    expect(recovered.assets).toHaveLength(1);
    expect(recovered.assets[0]?.sha256).toBe(retained.asset.sha256);
    expect((await repo.getJob(downloading.id)).state).toBe('queued');
    expect(await readFile(join(directory, retained.relativePath))).toEqual(image);
    await repo.cancel(downloading.id);
    await rm(join(directory, retained.relativePath));
    await repo.close();
    repo = await SqliteRepository.open(directory);
    expect((await repo.get(accepted.recordId)).assets[0]?.state).toBe('missing_on_disk');
    expect((await repo.history(accepted.recordId, historySchema.parse({}))).items).toHaveLength(1);
  } finally {
    await repo.close();
  }
});
it('fences late resolution after cancellation/deletion, and deletes no unrelated files', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const b = await fixtureBackend({
    resolve: async () => {
      started();
      await gate;
      return capture();
    },
  });
  roots.push(b.root);
  try {
    const saved = await b.save();
    await beginning;
    const token = await b.auth.mint('delete', ['read', 'write', 'delete']);
    const response = await b.app.inject({
      method: 'DELETE',
      url: '/api/v1/records/' + saved.recordId,
      headers: { ...b.headers, authorization: 'Bearer ' + token },
    });
    expect(response.statusCode).toBe(202);
    release();
    await b.settled();
    expect((await b.repo.jobs()).find((job) => job.id === saved.jobId)?.state).toBe('cancelled');
    await expect(b.repo.get(saved.recordId)).rejects.toMatchObject({ code: 'record_not_found' });
    expect(await readFile(join(b.root, 'credentials/agent-token.txt'), 'utf8')).toBeTruthy();
  } finally {
    release();
    await b.app.close();
  }
});
it('coalesces refreshes, replays completed idempotent refreshes and allows annotations during capture', async () => {
  let calls = 0;
  const b = await fixtureBackend({
    resolve: async () => capture({ at: `2026-10-01T00:00:0${calls++}.000Z` }),
  });
  roots.push(b.root);
  try {
    const { recordId } = await b.save();
    await b.settled();
    const headers = { ...b.headers, 'idempotency-key': 'stable-refresh' };
    const first = await b.app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/metadata/refresh`,
      payload: {},
      headers,
    });
    await b.settled();
    const again = await b.app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/metadata/refresh`,
      payload: {},
      headers,
    });
    await b.settled();
    expect(again.body).toBe(first.body);
    expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(2);
    await b.repo.annotate(recordId, { note: 'Independent revision', expectedRevision: 0 });
    expect((await b.repo.get(recordId)).metadataRevision).toBe(2);
  } finally {
    await b.app.close();
  }
});
it('refuses traversal and a symlink outside the owned data root', async () => {
  const directory = await root(),
    outside = await root();
  await mkdir(join(directory, 'records'));
  await symlink(
    outside,
    join(directory, 'records', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const files = new FileStore(
    directory,
    async () => {
      throw new AppError('unused', 'unused');
    },
    async () => null,
  );
  await expect(files.ownedPath('../secret')).rejects.toThrow('invalid');
  await expect(files.ownedPath('records/escape')).rejects.toThrow('outside');
});
