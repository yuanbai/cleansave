import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseYouTube } from '@cleansave/resolvers';
import { fixtureBackend } from './helpers.js';
import { mediaFixture } from './media-fixture.js';

test('retained derived MP4 decodes audio/video and seeks through the authenticated Range API', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'cleansave-playback-'));
  const media = await mediaFixture(root);
  const id = 'abcdefghijk',
    url = 'https://www.youtube.com/watch?v=' + id;
  const capture = parseYouTube(
    {
      playabilityStatus: { status: 'OK' },
      videoDetails: { videoId: id, title: 'Synthetic test' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            lastModified: '1',
            contentLength: String(media.video.length),
            width: 128,
            height: 128,
            mimeType: 'video/mp4; codecs="avc1.42001e"',
            url: `https://r1.googlevideo.com/videoplayback?itag=137&clen=${media.video.length}`,
          },
          {
            itag: 140,
            lastModified: '2',
            contentLength: String(media.audio.length),
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            url: `https://r1.googlevideo.com/videoplayback?itag=140&clen=${media.audio.length}`,
          },
        ],
      },
    },
    id,
    url,
  );
  if (!capture) throw new Error('Missing synthetic capture');
  const backend = await fixtureBackend(
    { resolve: async () => capture },
    {
      port: 4794,
      fetchMedia: async (address) => {
        const bytes =
          new URL(address).searchParams.get('itag') === '137' ? media.video : media.audio;
        return {
          url: address,
          body: Readable.from(bytes),
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        };
      },
    },
  );
  try {
    await backend.app.listen({ host: '127.0.0.1', port: 4794 });
    const accepted = await backend
      .service(['read', 'write'])
      .create({ input: url, downloadContent: true });
    await backend.settled();
    const record = await backend.repo.get(accepted.recordId),
      asset = record.assets[0];
    expect(record.downloadState).toBe('complete');
    if (!asset) throw new Error('Missing output');
    await page.setExtraHTTPHeaders({ authorization: 'Bearer ' + backend.token });
    await page.goto('http://127.0.0.1:4794/health');
    await page.setContent(
      `<video controls preload="auto" src="/api/v1/assets/${asset.id}/content"></video>`,
    );
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.readyState >= 2;
    });
    const duration = await page.evaluate(() => document.querySelector('video')?.duration ?? 0);
    expect(duration).toBeCloseTo(1.024, 2);
    for (const ratio of [0, 0.5, 0.9]) {
      const target = duration * ratio;
      await page.evaluate(async (target) => {
        const video = document.querySelector('video');
        if (!video) throw new Error('No video');
        video.pause();
        if (Math.abs(video.currentTime - target) > 0.01) {
          const seeked = new Promise<void>((resolve) =>
            video.addEventListener('seeked', () => resolve(), { once: true }),
          );
          video.currentTime = target;
          await seeked;
        }
        video.muted = true;
        await video.play();
      }, target);
      await page.waitForTimeout(80);
      const sample = await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement & {
          webkitVideoDecodedByteCount: number;
          webkitAudioDecodedByteCount: number;
        };
        return {
          time: video.currentTime,
          error: video.error?.code ?? null,
          video: video.webkitVideoDecodedByteCount,
          audio: video.webkitAudioDecodedByteCount,
        };
      });
      expect(sample.error).toBeNull();
      expect(sample.video).toBeGreaterThan(0);
      expect(sample.audio).toBeGreaterThan(0);
      expect(sample.time).toBeGreaterThanOrEqual(target);
    }
  } finally {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
