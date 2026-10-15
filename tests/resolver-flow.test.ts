import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PlatformResolver } from '@cleansave/resolvers';
import type { PageSession, Page } from '../packages/resolvers/src/network.js';
const url = 'https://www.iesdouyin.com/share/video/123/';
function session(pages: string[]): PageSession & { calls: number; closed: boolean } {
  return {
    calls: 0,
    closed: false,
    page: async function (): Promise<Page> {
      const text = pages[Math.min(this.calls++, pages.length - 1)] ?? '';
      return { text, url, redirects: [url] };
    },
    post: async () => {
      throw new Error('Unexpected');
    },
    cookieSnapshot: () => '',
    setCookie: () => {},
    close: async function () {
      this.closed = true;
    },
  };
}
it('recovers matching Douyin data after a visitor page followed by configuration-only SSR', async () => {
  const seed = Buffer.from('synthetic-seed');
  const challenge = Buffer.from(
    JSON.stringify({
      v: {
        a: seed.toString('base64'),
        c: createHash('sha256').update(seed).update('3').digest('base64'),
      },
    }),
  ).toString('base64');
  const mock = session([
    `<script>var wci="visitor",cs="${challenge}"</script>`,
    'window._ROUTER_DATA={"loaderData":{"video_(id)/page":{"itemId":"123"}}}',
    'window._ROUTER_DATA={"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"aweme_id":"123","desc":"Synthetic target","video":{"play_addr":{"uri":"stable","url_list":["https://test.douyincdn.com/video"]}}}]}}}}',
  ]);
  const result = await new PlatformResolver(() => mock).resolve(url, AbortSignal.timeout(1000));
  expect(result.postId).toBe('123');
  expect(result.sources[0]?.urls).toHaveLength(1);
  expect(mock.calls).toBe(3);
  expect(mock.closed).toBe(true);
});
it('treats an empty legacy loader as unavailable data rather than a JSON network failure', async () => {
  const mock = session(['window._ROUTER_DATA={"loaderData":{}}', '', '', '']);
  await expect(
    new PlatformResolver(() => mock).resolve(url, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: 'post_unavailable' });
  expect(mock.closed).toBe(true);
});

it('captures exact YouTube oEmbed metadata while preserving the actual player access refusal', async () => {
  const id = 'abcdefghijk';
  const mock = session([
    'ytInitialPlayerResponse={"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Confirm not a bot"}}',
  ]);
  mock.page = async function (request: string): Promise<Page> {
    this.calls++;
    const isEmbed = request.includes('/oembed?');
    return {
      url: request,
      redirects: [request],
      text: isEmbed
        ? JSON.stringify({
            title: 'Synthetic public film',
            author_name: 'Synthetic author',
            html: `<iframe src="https://www.youtube.com/embed/${id}?feature=oembed"></iframe>`,
          })
        : 'ytInitialPlayerResponse={"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Confirm not a bot"}}',
    };
  };
  const result = await new PlatformResolver(() => mock).resolve(
    'https://www.youtube.com/watch?v=' + id,
    AbortSignal.timeout(1000),
  );
  expect(result.metadata.title).toBe('Synthetic public film');
  expect(result.accessError?.code).toBe('platform_verification_required');
  expect(result.counts.likes).toBeNull();
  expect(result.sources).toHaveLength(0);
  expect(mock.calls).toBe(3);
});
