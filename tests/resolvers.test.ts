import { describe, expect, it } from 'vitest';
import {
  inspectInput,
  approvedUrl,
  postIds,
  matchedTarget,
  isPublicAddress,
  count,
  parseJson,
  assignment,
  parseDouyin,
  parseXiaohongshu,
  parseKuaishou,
  parseTikTok,
  parseYouTube,
  NetworkSession,
} from '@cleansave/resolvers';
import { CookieJar } from 'tough-cookie';
const dy = 'https://www.douyin.com/video/123';
describe('untrusted input and controlled network', () => {
  it('extracts and deduplicates messages, upgrades approved HTTP links, rejects unsafe families', () => {
    expect(
      inspectInput(
        '分享 http://www.douyin.com/video/123。 https://www.douyin.com/video/123 https://www.youtube.com/watch?v=abcdefghijk',
      ),
    ).toHaveLength(2);
    for (const url of [
      'https://douyin.com.evil.example/video/123',
      'https://user:pass@www.douyin.com/video/123',
      'https://www.douyin.com:444/video/123',
      'http://sns-img-bd.xhscdn.com/a',
    ])
      expect(() => approvedUrl(url, url.includes('xhscdn'))).toThrow();
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '169.254.169.254',
      '::1',
      'fc00::1',
      '::ffff:8.8.8.8',
      '224.0.0.1',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(postIds('douyin', new URL(dy + '?modal_id=456'))).toEqual([]);
    expect(
      postIds('youtube', new URL('https://www.youtube.com/watch?v=abcdefghijk&v=abcdefghijk')),
    ).toEqual([]);
    expect(() => matchedTarget('douyin', [dy, 'https://www.douyin.com/video/456'])).toThrow();
  });
  it('keeps anonymous cookies scoped and closes on a pre-aborted network request', async () => {
    const session = new NetworkSession();
    session.setCookie('visitor', 'value', 'www.douyin.com');
    const jar = CookieJar.deserializeSync(session.cookieSnapshot());
    expect(jar.getCookieStringSync('https://www.douyin.com/')).toContain('visitor=');
    expect(jar.getCookieStringSync('https://www.youtube.com/')).toBe('');
    expect(jar.getCookieStringSync('https://v.douyin.com/')).toBe('');
    await expect(session.page(dy, AbortSignal.abort())).rejects.toThrow();
    await session.close();
  });
});
describe('platform fixtures and numeric observations', () => {
  it('preserves huge integers/rounded counts and parses assignments without evaluating code', () => {
    expect(
      parseJson('{"id":90071992547409931,"label":"90071992547409931","gone":undefined}'),
    ).toEqual({ id: '90071992547409931', label: '90071992547409931', gone: null });
    expect(count('1.2万')).toEqual({ kind: 'rounded', display: '1.2万' });
    expect(count(0)).toEqual({ kind: 'exact', value: '0' });
    expect(count(-1)).toBeNull();
    expect(assignment('window.X = {"text":"} ; {"}; bad()', 'window.X')).toEqual({
      text: '} ; {',
    });
  });
  it('matches requested Douyin identity and keeps missing album slots in order', () => {
    const result = parseDouyin(
      {
        recommended: { aweme_id: 'other', video: {} },
        post: {
          aweme_id: '123',
          images: [
            { uri: 'a', url_list: ['https://a.douyincdn.com/a'] },
            { uri: 'b', url_list: [] },
          ],
          desc: 'target',
          statistics: { digg_count: '90071992547409931', play_count: 0 },
        },
      },
      '123',
      dy,
    );
    expect(result?.metadata.description).toBe('target');
    expect(result?.sources).toHaveLength(2);
    expect(result?.sources[1]?.media.position).toBe(1);
    expect(result?.sources[1]?.urls).toEqual([]);
    expect(result?.counts.views).toBeNull();
    expect(result?.counts.likes).toEqual({ kind: 'exact', value: '90071992547409931' });
    expect(parseDouyin({ aweme_id: 'other', video: {} }, '123', dy)).toBeNull();
  });
  it('retains XHS original keys, TikTok scoped stats, and Kuaishou explicit alias association', () => {
    const xhs = parseXiaohongshu(
      {
        noteId: 'abcdef',
        type: 'normal',
        imageList: [{ fileId: 'original/image' }],
        interactInfo: { likedCount: '2万' },
      },
      'abcdef',
      'https://www.xiaohongshu.com/explore/abcdef?xsec_token=fixture',
    );
    expect(xhs?.sources[0]?.media.sourceKey).toBe('original/image');
    expect(xhs?.counts.likes?.kind).toBe('rounded');
    const tt = parseTikTok(
      {
        id: '123',
        desc: 'fixture',
        video: { id: 'video', playAddr: 'https://a.tiktokcdn.com/video' },
        stats: { diggCount: 10 },
        statsV2: { diggCount: '12' },
      },
      '123',
      'https://www.tiktok.com/@test/video/123',
    );
    expect(tt?.counts.likes).toEqual({ kind: 'exact', value: '12' });
    const ks = {
      photoId: 'numeric',
      share_info: 'photoId=alias',
      manifest: {
        adaptationSet: [{ representation: [{ id: 'h264', url: 'https://a.kwaicdn.com/video' }] }],
      },
    };
    expect(
      parseKuaishou(ks, ['alias', 'numeric'], 'https://www.kuaishou.com/photo/alias')?.postId,
    ).toBe('numeric');
    expect(
      parseKuaishou(
        { ...ks, share_info: '' },
        ['alias', 'numeric'],
        'https://www.kuaishou.com/photo/alias',
      ),
    ).toBeNull();
  });
  it('supports only matching direct combined YouTube formats and reports gates/adaptive-only results', () => {
    const player = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { videoId: 'abcdefghijk', title: 'Fixture video', viewCount: '100' },
      streamingData: {
        formats: [
          {
            itag: 18,
            contentLength: '1024',
            lastModified: '123',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            url: 'https://r1.googlevideo.com/videoplayback?itag=18&clen=1024',
          },
        ],
      },
    };
    const result = parseYouTube(player, 'abcdefghijk', 'https://youtu.be/abcdefghijk');
    expect(result?.sources[0]?.urls).toHaveLength(1);
    const adaptive = [
      {
        itag: 137,
        contentLength: '2048',
        lastModified: '234',
        mimeType: 'video/mp4; codecs="avc1.640028"',
        url: 'https://r1.googlevideo.com/videoplayback?itag=137&clen=2048',
      },
      {
        itag: 140,
        contentLength: '512',
        lastModified: '345',
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        url: 'https://r1.googlevideo.com/videoplayback?itag=140&clen=512',
      },
    ];
    const mixed = parseYouTube(
      { ...player, streamingData: { ...player.streamingData, adaptiveFormats: adaptive } },
      'abcdefghijk',
      'https://youtu.be/abcdefghijk',
    );
    const onlyTracks = parseYouTube(
      { ...player, streamingData: { adaptiveFormats: adaptive } },
      'abcdefghijk',
      'https://youtu.be/abcdefghijk',
    );
    expect(mixed?.sources[0]?.plan).toBeUndefined();
    expect(mixed?.sources.find((source) => source.plan)?.media.sourceKey).toBe(
      onlyTracks?.sources[0]?.media.sourceKey,
    );
    expect(onlyTracks?.sources[0]?.plan?.parts.map((part) => part.role)).toEqual([
      'video',
      'audio',
    ]);
    expect(parseYouTube(player, 'other123456', 'https://youtu.be/other123456')).toBeNull();
    expect(() =>
      parseYouTube(
        { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Confirm not a bot' } },
        'abcdefghijk',
        'https://youtu.be/abcdefghijk',
      ),
    ).toThrow('verification');
    expect(
      parseYouTube(
        { ...player, streamingData: { adaptiveFormats: [] } },
        'abcdefghijk',
        'https://youtu.be/abcdefghijk',
      )?.metadata.warnings,
    ).toContain('unsupported_format');
  });
});
