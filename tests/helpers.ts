import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { emptyCounts, type Counts } from '@cleansave/contracts';
import { AppError, type Capture, type Resolver } from '@cleansave/core';
import { createBackend } from '../apps/server/src/server.js';

/** A synthetic one-pixel PNG used for deterministic download and content-range tests. */
export const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ5kAAAAASUVORK5CYII=',
  'base64',
);

/** Build a synthetic same-post capture for offline lifecycle and media tests. */
export function capture(
  options: {
    title?: string;
    at?: string;
    counts?: Partial<Counts>;
    id?: string;
    clean?: boolean;
    items?: number;
  } = {},
): Capture {
  const postId = options.id ?? '12345';
  return {
    platform: 'douyin',
    postId,
    metadata: {
      title: options.title ?? 'Fixture landscape',
      description: 'Synthetic test description',
      canonicalUrl: 'https://www.douyin.com/video/' + postId,
      author: { name: 'Test author', id: 'test', handle: null, profileUrl: null },
      publishedAt: null,
      capturedAt: options.at ?? new Date().toISOString(),
      adapterVersion: 'fixture/1',
      warnings: [],
    },
    counts: { ...emptyCounts(), likes: { kind: 'exact', value: '10' }, ...options.counts },
    sources: Array.from({ length: options.items ?? 1 }, (_, position) => ({
      media: {
        itemId: 'item' + position,
        variantId: 'original',
        sourceKey: 'synthetic' + position,
        kind: 'image',
        position,
        required: true,
        width: 1,
        height: 1,
        codec: null,
        expectedBytes: image.length,
        watermarkStatus: options.clean === false ? 'unknown' : 'clean',
        provenance: 'original',
        evidence: 'synthetic fixture',
      },
      urls: ['https://test.douyincdn.com/' + position],
      referer: 'https://www.douyin.com/',
      userAgent: 'test',
    })),
  };
}

/**
 * Create an isolated temporary library with synthetic resolver/media access and job-settling
 * helpers.
 */
export async function fixtureBackend(
  resolver: Resolver = { resolve: async () => capture() },
  extra: Partial<Parameters<typeof createBackend>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'cleansave-test-'));
  const backend = await createBackend({
    root,
    resolver,
    fetchMedia: async (url) => ({
      body: Readable.from(image),
      headers: { 'content-length': String(image.length) },
      status: 200,
      url,
    }),
    ...extra,
  });
  const token = (await readFile(join(root, 'credentials/agent-token.txt'), 'utf8')).trim();
  const headers = { host: '127.0.0.1:4777', authorization: 'Bearer ' + token };
  const save = async (
    downloadContent = false,
    requireNoWatermark = false,
    input = 'https://www.douyin.com/video/12345',
  ) => {
    const response = await backend.app.inject({
      method: 'POST',
      url: '/api/v1/records',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { input, downloadContent, requireNoWatermark },
    });
    if (response.statusCode !== 202) throw new Error(response.body);
    return response.json<{ recordId: string; jobId: string }>();
  };
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 1000; i++) {
      if (!(await backend.repo.jobs()).some((job) => ['queued', 'running'].includes(job.state)))
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new AppError('test_timeout', 'Fixture jobs did not settle.');
  };
  return { ...backend, root, token, headers, save, settled };
}
