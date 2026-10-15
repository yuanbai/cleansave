import { expect, it } from 'vitest';
import {
  evaluateYoutubeGuest,
  transformYoutubeFormats,
  youtubeFetch,
  youtubeMediaUrl,
} from '@cleansave/resolvers';
import type { PageSession } from '../packages/resolvers/src/network.js';

it('isolates guest globals and function constructors from Node and limits CPU/memory', async () => {
  const signal = AbortSignal.timeout(10000);
  expect(
    await evaluateYoutubeGuest(
      'JSON.stringify([typeof process, typeof require, typeof fetch, typeof WebSocket, (new Function("return typeof process"))()])',
      signal,
    ),
  ).toBe('["undefined","undefined","undefined","undefined","undefined"]');
  expect(await evaluateYoutubeGuest('({ n: "transformed", sig: "signature" })', signal)).toEqual({
    n: 'transformed',
    sig: 'signature',
  });
  await expect(evaluateYoutubeGuest('while(true){}', signal)).rejects.toMatchObject({
    code: 'worker_failed',
  });
  await expect(evaluateYoutubeGuest('new ArrayBuffer(64*1024*1024)', signal)).rejects.toMatchObject(
    { code: 'worker_failed' },
  );
});
it('terminates a running guest on cancellation and bounds script input', async () => {
  const controller = new AbortController();
  const task = evaluateYoutubeGuest('while(true){}', controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(task).rejects.toMatchObject({ code: 'cancelled' });
  } finally {
    clearTimeout(timer);
  }
  await expect(
    evaluateYoutubeGuest(' '.repeat(1024 * 1024 + 1), AbortSignal.timeout(5000)),
  ).rejects.toMatchObject({ code: 'worker_failed' });
});
it('processes matching direct formats in the packaged worker without making a player request', async () => {
  const format = {
    itag: 18,
    mimeType: 'video/mp4; codecs="avc1.42001e, mp4a.40.2"',
    contentLength: '1024',
    lastModified: '123',
    bitrate: 100,
    url: 'https://r1.googlevideo.com/videoplayback?itag=18&clen=1024',
  };
  const session: PageSession = {
    page: async () => {
      throw new Error('Unexpected network');
    },
    post: async () => {
      throw new Error('Unexpected network');
    },
    cookieSnapshot: () => '',
    setCookie: () => {},
    close: async () => {},
  };
  const result = await transformYoutubeFormats([format], session, AbortSignal.timeout(5000));
  expect(result[0]?.url).toBe(format.url);
  expect(() => youtubeMediaUrl('https://127.0.0.1/videoplayback?itag=18', format)).toThrow();
  expect(() =>
    youtubeMediaUrl('https://r1.googlevideo.com/videoplayback?itag=22&clen=1024', format),
  ).toThrow();
  expect(() =>
    youtubeMediaUrl('https://r1.googlevideo.com/videoplayback?itag=18&itag=22', format),
  ).toThrow();
});
it('confines the Node client to same-video public read endpoints and omits imported credentials', async () => {
  let observed: unknown;
  let supplied: Record<string, string> | undefined;
  const session: PageSession = {
    page: async (url, _signal, headers) => {
      supplied = headers;
      return { url, redirects: [url], text: 'bootstrap' };
    },
    post: async (url, body, _signal, headers) => {
      supplied = headers;
      return {
        url,
        redirects: [url],
        text: JSON.stringify({ videoDetails: { videoId: 'abcdefghijk' }, request: body }),
      };
    },
    cookieSnapshot: () => '',
    setCookie: () => {},
    close: async () => {},
  };
  const request = youtubeFetch(session, 'abcdefghijk', AbortSignal.timeout(1000), (value) => {
    observed = value;
  });
  await request('https://www.youtube.com/sw.js_data', {
    headers: { cookie: 'private', authorization: 'Bearer private', 'user-agent': 'test' },
  });
  expect(supplied).toEqual({ 'user-agent': 'test' });
  await request('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'abcdefghijk' }),
  });
  expect(observed).toMatchObject({ videoDetails: { videoId: 'abcdefghijk' } });
  await expect(
    request('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'other123456' }),
    }),
  ).rejects.toMatchObject({ code: 'source_changed' });
  await expect(
    request('https://www.youtube.com/youtubei/v1/like', { method: 'POST' }),
  ).rejects.toMatchObject({ code: 'unsafe_url' });
});
