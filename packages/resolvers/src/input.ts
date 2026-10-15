import { AppError } from '@cleansave/core';
import type { Candidate, Platform } from '@cleansave/contracts';

/** Platform page host families accepted during share-link inspection and resolution. */
export const pageDomains: Record<Platform, string[]> = {
  douyin: ['douyin.com', 'iesdouyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'rednote.com'],
  kuaishou: ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com'],
  tiktok: ['tiktok.com', 'tiktokv.com'],
  youtube: ['youtube.com', 'youtube-nocookie.com', 'youtu.be'],
};

/**
 * Approved platform and CDN host families; connection policy additionally validates resolved IPs.
 */
export const mediaDomains = [
  ...Object.values(pageDomains).flat(),
  'snssdk.com',
  'amemv.com',
  'douyinvod.com',
  'douyincdn.com',
  'douyinpic.com',
  'toutiaovod.com',
  'zjcdn.com',
  'byteicdn.com',
  'bytevcloudvod.com',
  'volces.com',
  'bytecdn.cn',
  'bytecdn.com',
  'bytedance.com',
  'bytedance.net',
  'bytedanceapi.com',
  'byteimg.com',
  'ibytedtos.com',
  'byteoversea.com',
  'bytedancecdn.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'ttwstatic.com',
  'muscdn.com',
  'xhscdn.com',
  'rednotecdn.com',
  'kwaicdn.com',
  'kwai.net',
  'kscdn.com',
  'ksapisrv.com',
  'kwaipic.com',
  'kwimgs.com',
  'googlevideo.com',
  'ytimg.com',
];

/** Match an exact host or subdomain at a dot boundary, avoiding suffix lookalikes. */
export function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith('.' + domain));
}

/** Identify the platform owning an approved page host, or return null for unrelated hosts. */
export function platformFor(host: string): Platform | null {
  for (const [platform, domains] of Object.entries(pageDomains))
    if (hostMatches(host, domains)) return platform as Platform;
  return null;
}

/**
 * Validate a source URL and upgrade approved HTTP page links to HTTPS; media always requires HTTPS.
 */
export function approvedUrl(value: string, media = false): URL {
  let url: URL;
  try {
    url = new URL(value.startsWith('//') ? 'https:' + value : value);
  } catch {
    throw new AppError('unsafe_url', 'The address is not valid.');
  }
  if (
    url.username ||
    url.password ||
    (url.port && url.port !== '443' && !(url.protocol === 'http:' && url.port === '80'))
  )
    throw new AppError(
      'unsafe_url',
      'Credentials and custom ports are not supported in source URLs.',
    );
  const platform = platformFor(url.hostname);
  if (!media && platform && url.protocol === 'http:') {
    url.protocol = 'https:';
    url.port = '';
  }
  if (
    url.protocol !== 'https:' ||
    !hostMatches(url.hostname, media ? mediaDomains : Object.values(pageDomains).flat())
  )
    throw new AppError('unsafe_url', 'The source address is not approved.');
  return url;
}

/** Extract unique supported links from a bounded share message without making network requests. */
export function inspectInput(input: string): Candidate[] {
  if (!input || new TextEncoder().encode(input).byteLength > 16384)
    throw new AppError('unsupported_input', 'Paste a link or a short share message.');
  const result = new Map<string, Candidate>();
  for (const match of input.matchAll(/https?:\/\/[^\s<>"'[\]]+/g)) {
    try {
      const url = approvedUrl(match[0].replace(/[),，。；！）】]+$/, ''));
      const platform = platformFor(url.hostname);
      if (platform) result.set(url.toString(), { url: url.toString(), platform });
    } catch {
      /* Unrelated links are not supported candidates. */
    }
  }
  return [...result.values()];
}

/**
 * Select the sole supported candidate or validate an explicit selection; reject ambiguous messages.
 */
export function selectInput(input: string, selectedUrl?: string): Candidate {
  const candidates = inspectInput(input);
  if (!candidates.length)
    throw new AppError('unsupported_input', 'No supported social-media link was found.');
  const selected = selectedUrl
    ? candidates.find((candidate) => candidate.url === approvedUrl(selectedUrl).toString())
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!selected)
    throw new AppError('ambiguous_input', 'Choose one supported link from the message.');
  return selected;
}

function queryId(url: URL, name: string, pattern: RegExp): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !pattern.test(values[0] ?? '')) return null;
  return values[0] ?? null;
}

/** Read supported same-platform post identifiers from paths or unambiguous identity parameters. */
export function postIds(platform: Platform, url: URL): string[] {
  if (platformFor(url.hostname) !== platform) return [];
  let path: string | undefined;
  let query: string | null = null;
  switch (platform) {
    case 'douyin': {
      path = /^\/(?:share\/|m\/)?(?:video|note|slides)\/(\d+)\/?$/.exec(url.pathname)?.[1];
      const key =
        url.hostname === 'open.douyin.com' && url.pathname === '/player/video' ? 'vid' : 'modal_id';
      query = queryId(url, key, /^\d+$/);
      if (url.searchParams.has(key) && !query) return [];
      if (path && query && path !== query) return [];
      break;
    }
    case 'xiaohongshu':
      path = /^\/(?:explore|discovery\/item|item|user\/profile\/[^/]+)\/([a-f\d]+)\/?$/i.exec(
        url.pathname,
      )?.[1];
      break;
    case 'tiktok':
      path =
        /^\/(?:@[^/]+\/(?:video|photo)|share\/video|video|embed(?:\/v2)?|player\/v1)\/(\d+)\/?$/.exec(
          url.pathname,
        )?.[1];
      break;
    case 'kuaishou':
      path = /^\/(?:short-video|(?:fw\/)?photo)\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
      query = queryId(url, 'photoId', /^[\w-]+$/);
      if (url.searchParams.has('photoId') && !query) return [];
      break;
    case 'youtube': {
      if (['/embed/videoseries', '/embed/live_stream'].includes(url.pathname.replace(/\/$/, '')))
        return [];
      path = hostMatches(url.hostname, ['youtu.be'])
        ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
        : /^\/(?:shorts|embed|live|v)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
      if (url.pathname === '/watch') query = queryId(url, 'v', /^[\w-]{11}$/);
      if (url.searchParams.has('v') && !query && url.pathname === '/watch') return [];
      break;
    }
  }
  return [...new Set([path, query].filter((id): id is string => Boolean(id)))];
}

/**
 * Pin post identity across redirects; Kuaishou aliases require additional same-post manifest
 * matching.
 */
export function matchedTarget(platform: Platform, urls: string[]): string[] {
  const ids = [...new Set(urls.flatMap((url) => postIds(platform, approvedUrl(url))))];
  if (platform !== 'kuaishou' && ids.length > 1)
    throw new AppError('source_changed', 'The share link redirected to a different post.', 409);
  if (!ids.length)
    throw new AppError('post_unavailable', 'The link did not identify one post.', 422);
  return ids;
}
