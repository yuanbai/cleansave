import { afterEach, describe, expect, it } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { AppError } from '@cleansave/core';
import { historySchema, listSchema } from '@cleansave/contracts';
import { fixtureBackend, capture, image } from './helpers.js';
const instances: Awaited<ReturnType<typeof fixtureBackend>>[] = [];
it('reports media HTTP 403 without retaining response bytes or inventing count captures', async () => {
  const b = await fixture(undefined, {
    fetchMedia: async (url) => ({
      url,
      status: 403,
      headers: {},
      body: Readable.from('private upstream refusal body'),
    }),
  });
  const saved = await b.save(true);
  await b.settled();
  const record = await b.repo.get(saved.recordId);
  expect(record.downloadState).toBe('failed');
  expect(record.error?.code).toBe('media_access_refused');
  expect(JSON.stringify(record)).not.toContain('private upstream refusal body');
  expect(record.assets).toEqual([]);
  expect((await b.repo.history(record.id, historySchema.parse({}))).items).toHaveLength(1);
});
afterEach(async () => {
  for (const backend of instances.splice(0)) {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});
async function fixture(...args: Parameters<typeof fixtureBackend>) {
  const result = await fixtureBackend(...args);
  instances.push(result);
  return result;
}
describe('capture and library lifecycle', () => {
  it('saves metadata without media network access; reuses identical pastes and idempotency keys', async () => {
    let calls = 0;
    const b = await fixture(undefined, {
      fetchMedia: async () => {
        calls++;
        throw new Error('unexpected');
      },
    });
    const saved = await b.save();
    await b.settled();
    const r = await b.repo.get(saved.recordId);
    expect(r.options).toEqual({ downloadContent: false, requireNoWatermark: false });
    expect(r.assets).toEqual([]);
    expect(calls).toBe(0);
    const duplicate = await b.save();
    await b.settled();
    expect(duplicate.recordId).toBe(saved.recordId);
    expect(await b.repo.history(saved.recordId, historySchema.parse({}))).toMatchObject({
      items: [{ counts: { likes: { value: '10' } } }],
    });
    const payload = { input: 'https://www.douyin.com/video/12345' };
    const headers = { ...b.headers, 'idempotency-key': 'fixture-idempotent' };
    const first = await b.app.inject({ method: 'POST', url: '/api/v1/records', headers, payload });
    const second = await b.app.inject({ method: 'POST', url: '/api/v1/records', headers, payload });
    expect(first.body).toBe(second.body);
    expect(
      (
        await b.app.inject({
          method: 'POST',
          url: '/api/v1/records',
          headers,
          payload: { ...payload, downloadContent: true },
        })
      ).statusCode,
    ).toBe(409);
    const page = await b.app.inject({ url: '/api/v1/records', headers: b.headers });
    expect(page.json().items[0]).not.toHaveProperty('metadata');
    expect(page.json().items[0]).not.toHaveProperty('assets');
  });
  it('replaces other metadata and keeps every count timestamp, null, rounded, decreasing and huge value', async () => {
    let n = 0;
    const snapshots = [
      capture({ at: '2026-10-01T00:00:00.000Z' }),
      capture({
        title: 'New title',
        at: '2026-10-02T00:00:00.000Z',
        counts: {
          likes: { kind: 'exact', value: '10' },
          comments: { kind: 'rounded', display: '1.2万' },
        },
      }),
      capture({
        at: '2026-10-03T00:00:00.000Z',
        counts: {
          likes: { kind: 'exact', value: '8' },
          views: { kind: 'exact', value: '90071992547409931' },
        },
      }),
    ];
    const b = await fixture({
      resolve: async () => {
        const value = snapshots[n++];
        if (!value) throw new AppError('network_unavailable', 'Test capture failed', 422);
        return value;
      },
    });
    const { recordId } = await b.save();
    await b.settled();
    await b.repo.annotate(recordId, { note: 'My draft', tags: ['tag'], expectedRevision: 0 });
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await b.app.inject({
            method: 'POST',
            url: `/api/v1/records/${recordId}/metadata/refresh`,
            headers: b.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(202);
      await b.settled();
    }
    const r = await b.repo.get(recordId);
    expect(r.metadataRevision).toBe(3);
    expect(r.note).toBe('My draft');
    expect(r.annotationRevision).toBe(1);
    expect(r.firstCapturedAt).toBe('2026-10-01T00:00:00.000Z');
    const history = await b.repo.history(recordId, historySchema.parse({}));
    expect(history.items).toHaveLength(3);
    expect(history.items[1]?.counts.comments).toEqual({ kind: 'rounded', display: '1.2万' });
    expect(history.items[2]?.counts.comments).toBeNull();
    expect(history.items[2]?.counts.likes).toEqual({ kind: 'exact', value: '8' });
    expect(history.items[2]?.counts.views).toEqual({ kind: 'exact', value: '90071992547409931' });
    const first = await b.repo.history(recordId, historySchema.parse({ limit: 1 }));
    const next = await b.repo.history(
      recordId,
      historySchema.parse({ limit: 1, cursor: first.nextCursor }),
    );
    expect(next.items[0]?.id).toBe(history.items[1]?.id);
    expect(
      (
        await b.repo.history(
          recordId,
          historySchema.parse({ from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' }),
        )
      ).items,
    ).toHaveLength(1);
    await b.app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/metadata/refresh`,
      headers: b.headers,
      payload: {},
    });
    await b.settled();
    expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(3);
    expect((await b.repo.get(recordId)).metadata).toEqual(r.metadata);
    expect((await b.repo.get(recordId)).refreshError?.code).toBe('network_unavailable');
  });
  it('merges aliases without new observations and preserves provisional notes', async () => {
    const b = await fixture();
    const first = await b.save();
    await b.settled();
    const second = await b.repo.create(
      {
        input: 'share',
        url: 'https://v.douyin.com/alias/',
        platform: 'douyin',
        downloadContent: false,
        requireNoWatermark: false,
      },
      null,
    );
    await b.repo.annotate(second.recordId, { note: 'Pending note', expectedRevision: 0 });
    b.worker.kick();
    await b.settled();
    const merged = await b.repo.get(second.recordId);
    expect(merged.mergedIntoId).toBe(first.recordId);
    expect((await b.repo.get(first.recordId)).annotationDrafts).toEqual([
      { note: 'Pending note', tags: [] },
    ]);
    expect((await b.repo.history(first.recordId, historySchema.parse({}))).items).toHaveLength(1);
    expect((await b.repo.list(listSchema.parse({}))).items).toHaveLength(1);
  });
  it('retains validated media, supports Range/HEAD and retries without recapturing metadata', async () => {
    let calls = 0;
    const b = await fixture({
      resolve: async () =>
        capture({
          title: calls++ ? 'New access title' : 'Original title',
          counts: { likes: { kind: 'exact', value: String(calls) } },
        }),
    });
    const { recordId } = await b.save(true);
    await b.settled();
    const record = await b.repo.get(recordId);
    expect(record.downloadState).toBe('complete');
    expect(record.metadata?.title).toBe('Original title');
    expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(1);
    const asset = record.assets[0];
    expect(asset).toBeDefined();
    const content = `/api/v1/assets/${asset?.id}/content`;
    const range = await b.app.inject({
      url: content,
      headers: { ...b.headers, range: 'bytes=0-7' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(image.subarray(0, 8));
    expect(range.headers['content-range']).toBe(`bytes 0-7/${image.length}`);
    expect((await b.app.inject({ method: 'HEAD', url: content, headers: b.headers })).body).toBe(
      '',
    );
    expect(
      (await b.app.inject({ url: content, headers: { ...b.headers, range: 'bytes=999-' } }))
        .statusCode,
    ).toBe(416);
    await b.app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/downloads`,
      headers: b.headers,
      payload: {},
    });
    await b.settled();
    expect((await b.repo.get(recordId)).assets).toHaveLength(1);
    expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(1);
    const entry = await b.repo.assetPath(asset?.id ?? '');
    expect(await readFile(await b.files.ownedPath(entry.relativePath))).toEqual(image);
  });
  it('keeps partial albums, retries missing items, and rejects wrong bytes and strict unknown sources', async () => {
    let failSecond = true;
    const b = await fixture(
      { resolve: async () => capture({ items: 2 }) },
      {
        fetchMedia: async (url) => ({
          body: Readable.from(
            url.endsWith('/1') && failSecond ? Buffer.from('<html>nope</html>') : image,
          ),
          status: 200,
          url,
          headers: {},
        }),
      },
    );
    const { recordId } = await b.save(true);
    await b.settled();
    const partial = await b.repo.get(recordId);
    expect(partial.downloadState).toBe('partial');
    expect(partial.assets).toHaveLength(1);
    expect(partial.media).toHaveLength(2);
    failSecond = false;
    await b.app.inject({
      method: 'POST',
      url: `/api/v1/records/${recordId}/downloads`,
      headers: b.headers,
      payload: {},
    });
    await b.settled();
    const complete = await b.repo.get(recordId);
    expect(complete.downloadState).toBe('complete');
    expect(complete.assets[0]?.id).toBe(partial.assets[0]?.id);
    expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(1);
    const strict = await fixture({ resolve: async () => capture({ clean: false }) });
    const saved = await strict.save(true, true);
    await strict.settled();
    expect((await strict.repo.get(saved.recordId)).error?.code).toBe('clean_source_unavailable');
    expect((await strict.repo.get(saved.recordId)).assets).toHaveLength(0);
    const policy = await strict.app.inject({
      url: '/api/v1/jobs/' + (await strict.repo.jobs()).find((job) => job.type === 'download')?.id,
      headers: strict.headers,
    });
    expect(policy.json().requireNoWatermark).toBe(true);
  });
  it('enforces private access, local origin/host and agent delete/path scopes', async () => {
    const b = await fixture();
    expect(
      (await b.app.inject({ url: '/api/v1/records', headers: { host: '127.0.0.1:4777' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await b.app.inject({ url: '/health', headers: { host: 'evil.example:4777' } })).statusCode,
    ).toBe(403);
    expect(
      (
        await b.app.inject({
          url: '/api/v1/records',
          headers: { ...b.headers, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    const { recordId } = await b.save(true);
    await b.settled();
    expect(
      (
        await b.app.inject({
          method: 'DELETE',
          url: `/api/v1/records/${recordId}`,
          headers: b.headers,
        })
      ).statusCode,
    ).toBe(403);
    const asset = (await b.repo.get(recordId)).assets[0];
    expect(
      (
        await b.app.inject({
          url: `/api/v1/assets/${asset?.id}?localPath=true`,
          headers: b.headers,
        })
      ).statusCode,
    ).toBe(403);
    const paired = await b.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777' },
      payload: { secret: b.auth.pairingSecret },
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.headers['set-cookie']).toContain('HttpOnly');
    expect(
      (
        await b.app.inject({
          method: 'POST',
          url: '/api/v1/session',
          headers: { host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777' },
          payload: { secret: b.auth.pairingSecret },
        })
      ).statusCode,
    ).toBe(401);
    const token = await b.auth.mint('delete-test', ['read', 'write', 'delete']);
    const headers = { ...b.headers, authorization: 'Bearer ' + token };
    await b.app.inject({ method: 'DELETE', url: `/api/v1/records/${recordId}/downloads`, headers });
    await b.settled();
    expect((await b.repo.get(recordId)).assets).toHaveLength(0);
    expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(1);
    await b.app.inject({ method: 'DELETE', url: `/api/v1/records/${recordId}`, headers });
    await b.settled();
    expect((await b.app.inject({ url: `/api/v1/records/${recordId}`, headers })).statusCode).toBe(
      404,
    );
  });
});

it('keeps partial metadata on access refusal and pins the first real manifest on a later download', async () => {
  let allowed = false;
  const b = await fixture({
    resolve: async () => {
      const value = capture();
      return allowed
        ? value
        : {
            ...value,
            sources: [],
            metadata: {
              ...value.metadata,
              warnings: ['partial_metadata', 'platform_verification_required'],
            },
            accessError: {
              code: 'platform_verification_required',
              message: 'Public access is refused.',
              retryable: false,
            },
          };
    },
  });
  const { recordId } = await b.save(true);
  await b.settled();
  const before = await b.repo.get(recordId);
  expect(before.metadata).not.toBeNull();
  expect(before.media).toHaveLength(0);
  expect(before.error?.code).toBe('platform_verification_required');
  await b.repo.annotate(recordId, { note: 'Keep this annotation', expectedRevision: 0 });
  allowed = true;
  await b.app.inject({
    method: 'POST',
    url: `/api/v1/records/${recordId}/downloads`,
    headers: b.headers,
    payload: {},
  });
  await b.settled();
  const after = await b.repo.get(recordId);
  expect(after.downloadState).toBe('complete');
  expect(after.media).toHaveLength(1);
  expect(after.metadata).toEqual(before.metadata);
  expect(after.note).toBe('Keep this annotation');
  expect((await b.repo.history(recordId, historySchema.parse({}))).items).toHaveLength(1);
});
