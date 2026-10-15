import { expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { gzipSync } from 'node:zlib';
import { NetworkSession } from '@cleansave/resolvers';

it('validates each redirect and refuses unsafe destinations before requesting them', async () => {
  const transport = new MockAgent();
  transport.disableNetConnect();
  transport
    .get('https://v.douyin.com')
    .intercept({ path: '/fixture/' })
    .reply(302, '', { headers: { location: 'https://www.douyin.com/video/123' } });
  transport
    .get('https://www.douyin.com')
    .intercept({ path: '/video/123' })
    .reply(200, 'matching post');
  const session = new NetworkSession('test', undefined, transport);
  try {
    const page = await session.page('http://v.douyin.com/fixture/', AbortSignal.timeout(1000));
    expect(page.redirects).toEqual([
      'https://v.douyin.com/fixture/',
      'https://www.douyin.com/video/123',
    ]);
    expect(page.text).toBe('matching post');
    transport
      .get('https://www.youtube.com')
      .intercept({ path: '/start', headers: { 'x-goog-visitor-id': 'anonymous-visitor' } })
      .reply(302, '', { headers: { location: 'https://www.douyin.com/redirect-target' } });
    transport
      .get('https://www.douyin.com')
      .intercept({ path: '/redirect-target' })
      .reply((options) => {
        const serialized = JSON.stringify(options.headers);
        expect(serialized).not.toContain('anonymous-visitor');
        return { statusCode: 200, data: 'safe redirect' };
      });
    expect(
      (
        await session.page('https://www.youtube.com/start', AbortSignal.timeout(1000), {
          'x-goog-visitor-id': 'anonymous-visitor',
        })
      ).text,
    ).toBe('safe redirect');
    transport
      .get('https://v.douyin.com')
      .intercept({ path: '/unsafe/' })
      .reply(302, '', { headers: { location: 'https://127.0.0.1/private' } });
    await expect(
      session.page('https://v.douyin.com/unsafe/', AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: 'unsafe_url' });
    transport.assertNoPendingInterceptors();
  } finally {
    await session.close();
  }
});
it('bounds redirects, decoded page size and transient status retries', async () => {
  const transport = new MockAgent();
  transport.disableNetConnect();
  const pool = transport.get('https://www.douyin.com');
  pool
    .intercept({ path: '/loop' })
    .reply(302, '', { headers: { location: '/loop' } })
    .times(9);
  pool
    .intercept({ path: '/retry' })
    .reply(503, '', { headers: { 'retry-after': '0' } })
    .times(2);
  pool.intercept({ path: '/retry' }).reply(200, 'recovered');
  pool.intercept({ path: '/gzip' }).reply(200, gzipSync(Buffer.alloc(6 * 1024 * 1024 + 1, 97)), {
    headers: { 'content-encoding': 'gzip' },
  });
  const session = new NetworkSession('test', undefined, transport);
  try {
    await expect(
      session.page('https://www.douyin.com/loop', AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ code: 'post_unavailable' });
    expect(
      (await session.page('https://www.douyin.com/retry', AbortSignal.timeout(2000))).text,
    ).toBe('recovered');
    await expect(
      session.page('https://www.douyin.com/gzip', AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ code: 'upstream_too_large' });
    transport.assertNoPendingInterceptors();
  } finally {
    await session.close();
  }
});

it('handles asynchronous abort errors when discarding an unread response', async () => {
  const { Readable } = await import('node:stream');
  const { discardBody } = await import('@cleansave/core');
  const body = new Readable({
    read() {},
    destroy(_error, done) {
      queueMicrotask(() =>
        done(Object.assign(new Error('Request aborted'), { code: 'UND_ERR_ABORTED' })),
      );
    },
  });
  const closed = new Promise<void>((resolve) => body.once('close', resolve));
  discardBody(body);
  await closed;
  expect(body.destroyed).toBe(true);
});
