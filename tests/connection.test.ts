import { expect, it } from 'vitest';
import { proxyEndpoint, publicDnsAnswers } from '@cleansave/resolvers';
it('limits explicit proxies to credential-free loopback HTTP endpoints', () => {
  expect(proxyEndpoint('http://127.0.0.1:1087')).toEqual({ host: '127.0.0.1', port: 1087 });
  for (const url of [
    'https://127.0.0.1:1087',
    'http://remote.example:8080',
    'http://user:secret@localhost:1087',
    'http://localhost:1087/path',
  ])
    expect(() => proxyEndpoint(url)).toThrow();
});
it('pins only matching secure-DNS answers and rejects private/mapped results', () => {
  const answer = (name: string, data: string, type = 1) => ({ name, data, type, TTL: 60 });
  expect(
    publicDnsAnswers(
      {
        Status: 0,
        Answer: [
          answer('www.youtube.com.', 'alias.google.com.', 5),
          answer('alias.google.com.', '8.8.8.8'),
          answer('unrelated.example.', '9.9.9.9'),
        ],
      },
      'www.youtube.com',
    ),
  ).toEqual({ addresses: ['8.8.8.8'], ttl: 60 });
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::ffff:8.8.8.8'])
    expect(() =>
      publicDnsAnswers({ Status: 0, Answer: [answer('www.youtube.com.', ip)] }, 'www.youtube.com'),
    ).toThrow('private');
  expect(() =>
    publicDnsAnswers(
      { Status: 0, Answer: [answer('unrelated.example.', '8.8.8.8')] },
      'www.youtube.com',
    ),
  ).toThrow('No supported');
});

it('keeps optional browser recovery metadata-only and blocks unrelated mutations', async () => {
  const { browserTarget, browserRequestAllowed: allowed } = await import('@cleansave/resolvers');
  expect(allowed('https://open.douyin.com/player/video?vid=123', 'GET', 'document')).toBe(true);
  expect(allowed('https://lf-developer-cdn.open-douyin.com/player.js', 'GET', 'script')).toBe(true);
  expect(
    allowed('https://open.douyin.com/api/douyin/v1/open/auth/embed_video/', 'POST', 'fetch', 1024),
  ).toBe(true);
  expect(
    allowed('https://open.douyin.com/api/douyin/v1/open/auth/embed_video/', 'POST', 'fetch', 20000),
  ).toBe(false);
  expect(
    allowed('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123', 'GET', 'xhr'),
  ).toBe(true);
  for (const kind of ['image', 'media', 'font', 'ping', 'websocket'])
    expect(allowed('https://www.douyin.com/media', 'GET', kind)).toBe(false);
  expect(allowed('https://v26-web.douyinvod.com/video.js', 'GET', 'script')).toBe(false);
  expect(allowed('https://www.douyin.com/aweme/v1/web/comment/publish/', 'POST', 'xhr', 10)).toBe(
    false,
  );
  expect(allowed('https://www.douyin.com/aweme/v1/play/?video_id=x', 'GET', 'fetch')).toBe(false);
  for (const value of [
    'https://127.0.0.1/',
    'https://lf-developer-cdn.open-douyin.com.evil.example/a.js',
    'http://lf-developer-cdn.open-douyin.com/a.js',
    'https://lf-developer-cdn.open-douyin.com:444/a.js',
  ])
    expect(() => browserTarget(value)).toThrow();
});
