import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { Input, FilePathSource, ALL_FORMATS } from 'mediabunny';
import { parseYouTube } from '@cleansave/resolvers';
import { FileStore, SqliteRepository } from '@cleansave/storage';
import { historySchema } from '@cleansave/contracts';
import { fixtureBackend } from './helpers.js';
import { mediaFixture } from './media-fixture.js';
const id = 'abcdefghijk',
  url = 'https://www.youtube.com/watch?v=' + id;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cleansave-mux-'));
  roots.push(root);
  return root;
}
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
function sample(video: Buffer, audio: Buffer) {
  const result = parseYouTube(
    {
      playabilityStatus: { status: 'OK' },
      videoDetails: {
        videoId: id,
        title: 'Synthetic red/silent video',
        viewCount: '90071992547409931',
      },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            lastModified: '123',
            contentLength: String(video.length),
            mimeType: 'video/mp4; codecs="avc1.42001e"',
            width: 128,
            height: 128,
            url: `https://r1.googlevideo.com/videoplayback?itag=137&clen=${video.length}`,
          },
          {
            itag: 140,
            lastModified: '456',
            contentLength: String(audio.length),
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128000,
            url: `https://r1.googlevideo.com/videoplayback?itag=140&clen=${audio.length}`,
          },
        ],
      },
    },
    id,
    url,
  );
  if (!result) throw new Error('Missing synthetic capture');
  return result;
}
async function parts(root: string): Promise<string[]> {
  const names = await readdir(join(root, 'staging'), { recursive: true }).catch(() => []);
  return names.filter((name) => name.endsWith('.part'));
}
it('downloads both tracks and retains one playable MP4 with public input receipts; completed retries preserve captures', async () => {
  const media = await mediaFixture(await directory());
  let calls = 0,
    transfers = 0;
  const b = await fixtureBackend(
    {
      resolve: async () => {
        calls++;
        return sample(media.video, media.audio);
      },
    },
    {
      fetchMedia: async (address) => {
        transfers++;
        const bytes =
          new URL(address).searchParams.get('itag') === '137' ? media.video : media.audio;
        return {
          body: Readable.from(bytes),
          url: address,
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        };
      },
    },
  );
  roots.push(b.root);
  try {
    const saved = await b.save(true, false, url);
    await b.settled();
    const record = await b.repo.get(saved.recordId),
      asset = record.assets[0];
    expect(record.downloadState).toBe('complete');
    expect(record.assets).toHaveLength(1);
    expect(asset?.provenance).toBe('derived_mux');
    expect(asset?.inputReceipts.map((r) => r.sha256)).toEqual([sha(media.video), sha(media.audio)]);
    expect(JSON.stringify(record)).not.toContain('videoplayback');
    if (!asset) throw new Error('Missing asset');
    const retained = await b.repo.assetPath(asset.id),
      path = join(b.root, retained.relativePath),
      bytes = await readFile(path);
    expect(sha(bytes)).toBe(asset.sha256);
    expect(bytes.length).toBe(asset.bytes);
    const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
    try {
      expect(await input.getVideoTracks()).toHaveLength(1);
      expect(await input.getAudioTracks()).toHaveLength(1);
      expect(await input.computeDuration()).toBeCloseTo(1.024, 2);
    } finally {
      input.dispose();
    }
    await b.repo.annotate(record.id, { note: 'Keep this', tags: ['red'], expectedRevision: 0 });
    const before = await b.repo.history(record.id, historySchema.parse({}));
    const count = calls;
    await b.repo.enqueue(record.id, 'download');
    b.worker.kick();
    await b.settled();
    expect(calls).toBe(count);
    expect(transfers).toBe(2);
    expect((await b.repo.get(record.id)).note).toBe('Keep this');
    expect(await b.repo.history(record.id, historySchema.parse({}))).toEqual(before);
    expect(await parts(b.root)).toEqual([]);
    const db = new Database(join(b.root, 'library.sqlite'), { readonly: true });
    try {
      expect(db.prepare('select count(*) as count from asset_inputs').get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  } finally {
    await b.app.close();
  }
});
it('rejects invalid audio and removes temporary video/audio/output files', async () => {
  const media = await mediaFixture(await directory());
  const b = await fixtureBackend(
    { resolve: async () => sample(media.video, media.audio) },
    {
      fetchMedia: async (address) => {
        const bytes =
          new URL(address).searchParams.get('itag') === '137'
            ? media.video
            : Buffer.alloc(media.audio.length, 0);
        return {
          body: Readable.from(bytes),
          url: address,
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        };
      },
    },
  );
  roots.push(b.root);
  try {
    const saved = await b.save(true, false, url);
    await b.settled();
    const record = await b.repo.get(saved.recordId);
    expect(record.downloadState).toBe('failed');
    expect(record.assets).toEqual([]);
    expect(await parts(b.root)).toEqual([]);
    expect((await b.repo.history(record.id, historySchema.parse({}))).items).toHaveLength(1);
  } finally {
    await b.app.close();
  }
});
it('fences cancellation between input transfers and never adopts an output', async () => {
  const media = await mediaFixture(await directory());
  let started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const b = await fixtureBackend(
    { resolve: async () => sample(media.video, media.audio) },
    {
      fetchMedia: async (address, _source, signal) => {
        if (new URL(address).searchParams.get('itag') === '140') {
          started();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          });
        }
        return {
          body: Readable.from(media.video),
          url: address,
          status: 200,
          headers: { 'content-length': String(media.video.length) },
        };
      },
    },
  );
  roots.push(b.root);
  try {
    const saved = await b.save(true, false, url);
    await waiting;
    const job = (await b.repo.jobs()).find(
      (job) =>
        job.recordId === saved.recordId && job.type === 'download' && job.state === 'running',
    );
    if (!job) throw new Error('Missing running job');
    await b.worker.cancel(job.id);
    await b.worker.stop();
    await b.settled();
    expect((await b.repo.get(saved.recordId)).assets).toEqual([]);
    expect(await parts(b.root)).toEqual([]);
    expect((await b.repo.getJob(job.id)).state).toBe('cancelled');
  } finally {
    await b.app.close();
  }
});
it('recovers a renamed mux output and both receipts after a finalization crash', async () => {
  const media = await mediaFixture(await directory()),
    root = await directory();
  let repo = await SqliteRepository.open(root);
  try {
    const accepted = await repo.create(
      { input: url, url, platform: 'youtube', downloadContent: false, requireNoWatermark: false },
      null,
    );
    const resolution = await repo.claim();
    if (!resolution) throw new Error('No resolution');
    const capture = sample(media.video, media.audio);
    await repo.capture(resolution, capture);
    await repo.updateJob({ ...resolution, state: 'succeeded' });
    await repo.enqueue(accepted.recordId, 'download');
    const job = await repo.claim();
    if (!job) throw new Error('No download');
    const files = new FileStore(
      root,
      async (address) => {
        const bytes =
          new URL(address).searchParams.get('itag') === '137' ? media.video : media.audio;
        return {
          body: Readable.from(bytes),
          url: address,
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        };
      },
      (recordId) => repo.get(recordId),
    );
    const source = capture.sources[0];
    if (!source) throw new Error('Missing mux plan');
    const output = await files.retain(
      job,
      await repo.get(accepted.recordId),
      source,
      AbortSignal.timeout(10000),
      () => {},
    );
    await expect(
      repo.finalize(job, output.asset, output.relativePath, async () => {
        await output.adopt();
        throw new Error('Power loss');
      }),
    ).rejects.toThrow('Power loss');
    await repo.close();
    repo = await SqliteRepository.open(root);
    expect((await repo.get(accepted.recordId)).assets[0]?.inputReceipts).toEqual(
      output.asset.inputReceipts,
    );
    const db = new Database(join(root, 'library.sqlite'), { readonly: true });
    try {
      expect(db.prepare('select count(*) as count from asset_inputs').get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
    expect(await parts(root)).toEqual([]);
  } finally {
    await repo.close();
  }
});
it('upgrades legacy direct assets and preserves their metadata/count captures', async () => {
  const backend = await fixtureBackend();
  roots.push(backend.root);
  const saved = await backend.save(true);
  await backend.settled();
  const before = await backend.repo.get(saved.recordId);
  const history = await backend.repo.history(before.id, historySchema.parse({}));
  await backend.app.close();
  const legacyAssets = before.assets.map((asset) =>
    Object.fromEntries(
      Object.entries(asset).filter(([key]) => !['provenance', 'inputReceipts'].includes(key)),
    ),
  );
  const db = new Database(join(backend.root, 'library.sqlite'));
  db.prepare('UPDATE records SET data=? WHERE id=?').run(
    JSON.stringify({ ...before, assets: legacyAssets }),
    before.id,
  );
  for (const asset of legacyAssets)
    db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset), asset.id);
  db.exec('DROP TABLE asset_inputs; PRAGMA user_version=1;');
  db.close();
  const repo = await SqliteRepository.open(backend.root);
  try {
    expect(await repo.get(before.id)).toEqual(before);
    expect(await repo.history(before.id, historySchema.parse({}))).toEqual(history);
    expect((await repo.get(before.id)).assets[0]?.provenance).toBe('direct');
    expect((await repo.get(before.id)).assets[0]?.inputReceipts).toEqual([]);
  } finally {
    await repo.close();
  }
});
