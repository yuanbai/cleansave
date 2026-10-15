import { AppError, type Capture, type Resolver } from '@cleansave/core';
import type { Platform } from '@cleansave/contracts';
import { approvedUrl, matchedTarget, platformFor, postIds } from './input.js';
import { assignment, object, parseJson, scriptStates, visitorChallenge } from './parsing.js';
import { resolveYoutube } from './youtube.js';
import { NetworkSession, desktopAgent, type PageSession } from './network.js';
import { parseDouyin, parseKuaishou, parseTikTok, parseXiaohongshu } from './platforms.js';

export {
  platformFor,
  inspectInput,
  selectInput,
  approvedUrl,
  postIds,
  hostMatches,
  matchedTarget,
} from './input.js';
export { NetworkSession, openMedia, isPublicAddress } from './network.js';
export {
  parseDouyin,
  parseXiaohongshu,
  parseKuaishou,
  parseTikTok,
  parseYouTube,
} from './platforms.js';
export { count, parseJson, assignment } from './parsing.js';
export { ConnectionPolicy, proxyEndpoint, publicDnsAnswers } from './connection.js';
export {
  evaluateYoutubeGuest,
  transformYoutubeFormats,
  youtubeFetch,
  youtubeMediaUrl,
} from './youtube.js';
export type { NetworkOptions } from './connection.js';
export {
  PublicBrowser,
  createBrowserGateway,
  browserTarget,
  browserRequestAllowed,
} from './browser.js';

/**
 * Resolve supported public share pages through controlled sessions and identity-checked fallbacks.
 */
export class PlatformResolver implements Resolver {
  /**
   * Create this component with explicit dependencies; no work starts until its public operations
   * are called.
   */
  constructor(
    private readonly sessionFactory: (platform?: Platform) => PageSession = () =>
      new NetworkSession(),
    private readonly recoverDouyin?: (
      id: string,
      signal: AbortSignal,
      pageUrl?: string,
    ) => Promise<Capture | null>,
  ) {}

  /**
   * Resolve a source link with cancellation; this operation does not download primary media bytes.
   */
  public async resolve(input: string, callerSignal: AbortSignal): Promise<Capture> {
    const original = approvedUrl(input),
      platform = platformFor(original.hostname);
    if (!platform) throw new AppError('unsupported_input', 'This platform is not supported.');
    const session = this.sessionFactory(platform),
      signal = AbortSignal.any([callerSignal, AbortSignal.timeout(60000)]);
    try {
      let request = original.toString();
      const known = postIds(platform, original)[0];
      if (platform === 'youtube') {
        if (!known) throw new AppError('unsupported_input', 'Use a link to one YouTube video.');
        request = `https://www.youtube.com/${original.pathname.startsWith('/shorts/') ? 'shorts/' + known : 'watch?v=' + known}`;
      }
      if (platform === 'tiktok' && known && /\/(?:photo|embed|player)\//.test(original.pathname)) {
        const target = new URL(original);
        target.hostname = 'www.tiktok.com';
        target.pathname = `/${/^\/(@[^/]+)\//.exec(original.pathname)?.[1] ?? '@_'}/video/${known}`;
        request = target.toString();
      }
      if (platform === 'douyin' && known && original.hostname === 'open.douyin.com')
        request = `https://www.iesdouyin.com/share/video/${known}/`;
      let page = await session.page(request, signal);
      const ids = matchedTarget(platform, [original.toString(), ...page.redirects, page.url]);
      const id = ids[0];
      if (!id)
        throw new AppError('post_unavailable', 'The requested post was not identified.', 422);
      let capture: Capture | null = null;
      if (platform === 'douyin') {
        for (let attempt = 0; attempt < 3; attempt++) {
          capture = parseDouyin(assignment(page.text, 'window._ROUTER_DATA'), id, page.url);
          if (capture) break;
          // The first response after the visitor challenge can contain only page
          // configuration. One further same-post reload can supply the real loader.
          visitorChallenge(page.text, page.url, session);
          if (attempt === 2) break;
          page = await session.page(page.url, signal);
          matchedTarget(platform, [original.toString(), ...page.redirects, page.url]);
        }
        if (!capture) {
          const album = /\/(?:note|slides)\//.test(page.url);
          const lookup = new URL(
            `https://www.iesdouyin.com/web/api/v2/aweme/${album ? 'slidesinfo' : 'iteminfo'}/`,
          );
          lookup.searchParams.set(album ? 'aweme_ids' : 'item_ids', album ? '[' + id + ']' : id);
          lookup.searchParams.set('reflow_source', 'reflow_page');
          if (album) lookup.searchParams.set('request_source', '200');
          let data = await session.page(lookup.toString(), signal);
          if (visitorChallenge(data.text, data.url, session))
            data = await session.page(data.url, signal);
          let parsed: Record<string, unknown> = {};
          try {
            parsed = object(parseJson(data.text));
          } catch {
            /* Public legacy loaders can return an empty refusal. */
          }
          if (parsed.status_code === 0)
            capture = parseDouyin(
              parsed,
              id,
              `https://www.iesdouyin.com/share/${album ? 'note' : 'video'}/${id}/`,
            );
        }
      } else if (platform === 'xiaohongshu') {
        capture = parseXiaohongshu(assignment(page.text, 'window.__INITIAL_STATE__'), id, page.url);
        if (!capture) {
          const desktop = new URL(page.url);
          desktop.hostname = 'www.xiaohongshu.com';
          desktop.pathname = '/explore/' + id;
          page = await session.page(desktop.toString(), signal);
          matchedTarget(platform, [original.toString(), ...page.redirects, page.url]);
          capture = parseXiaohongshu(
            assignment(page.text, 'window.__INITIAL_STATE__'),
            id,
            page.url,
          );
        }
      } else if (platform === 'kuaishou') {
        capture = parseKuaishou(
          assignment(page.text, 'window.__APOLLO_STATE__') ??
            assignment(page.text, 'window.INIT_STATE'),
          ids,
          page.url,
        );
        if (!capture) {
          const desktop = new URL(page.url);
          desktop.hostname = 'www.kuaishou.com';
          desktop.pathname = '/short-video/' + id + '/';
          page = await session.page(desktop.toString(), signal);
          capture = parseKuaishou(
            assignment(page.text, 'window.__APOLLO_STATE__') ??
              assignment(page.text, 'window.INIT_STATE'),
            ids,
            page.url,
          );
        }
      } else if (platform === 'tiktok') {
        capture =
          scriptStates(page.text)
            .map((state) => parseTikTok(state, id, page.url))
            .find(Boolean) ?? null;
        if (!capture && visitorChallenge(page.text, page.url, session)) {
          page = await session.page(page.url, signal);
          matchedTarget(platform, [original.toString(), ...page.redirects, page.url]);
          capture =
            scriptStates(page.text)
              .map((state) => parseTikTok(state, id, page.url))
              .find(Boolean) ?? null;
        }
      } else {
        capture = await resolveYoutube(session, id, page, signal);
        if (!capture && original.pathname.startsWith('/shorts/')) {
          page = await session.page(`https://www.youtube.com/watch?v=${id}`, signal);
          capture = await resolveYoutube(session, id, page, signal);
        }
      }
      if (
        platform === 'douyin' &&
        this.recoverDouyin &&
        (!capture ||
          capture.sources.some(
            (source) =>
              source.media.kind === 'video' &&
              source.urls.some((url) => new URL(url).hostname.endsWith('snssdk.com')),
          ))
      ) {
        try {
          capture =
            (await this.recoverDouyin(
              id,
              signal,
              /\/(?:note|slides)\//.test(page.url) ? page.url : undefined,
            )) ?? capture;
        } catch (error) {
          if (!capture || callerSignal.aborted) throw error;
          capture.metadata.warnings.push('public_player_recovery_unavailable');
        }
      }
      if (!capture)
        throw new AppError(
          'post_unavailable',
          'The matching public post could not be resolved. The platform may be refusing access.',
          422,
        );
      if (
        capture.sources.filter((source) => source.media.required && source.media.kind === 'image')
          .length > 250
      )
        throw new AppError('too_many_media', 'The album exceeds the supported item limit.', 413);
      const sources = [...capture.sources].sort(
        (a, b) =>
          Number(b.media.watermarkStatus === 'clean') -
            Number(a.media.watermarkStatus === 'clean') ||
          Number(b.media.provenance === 'original') - Number(a.media.provenance === 'original') ||
          Number(a.media.provenance === 'derived_mux') -
            Number(b.media.provenance === 'derived_mux') ||
          Number(a.media.codec === 'hevc') - Number(b.media.codec === 'hevc') ||
          (b.media.width ?? 0) * (b.media.height ?? 0) -
            (a.media.width ?? 0) * (a.media.height ?? 0),
      );
      return {
        ...capture,
        sources: sources.map((source) => ({
          ...source,
          userAgent: source.userAgent || desktopAgent,
          cookies: source.cookies ?? session.cookieSnapshot(),
        })),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (callerSignal.aborted) throw new AppError('cancelled', 'Resolution was cancelled.', 409);
      throw new AppError(
        'network_unavailable',
        'The platform could not be reached or returned invalid public data.',
        422,
        true,
      );
    } finally {
      await session.close();
    }
  }
}

/**
 * Advertised adapter formats and limitations; runtime validation status is added by the backend.
 */
export const capabilities = [
  {
    platform: 'douyin',
    images: true,
    video: true,
    method: 'Public share/router and JSON loader with optional isolated public-player recovery',
    limitations: [
      'Anonymous availability varies',
      'Public-player recovery requires an explicitly configured local Chromium executable',
    ],
  },
  {
    platform: 'xiaohongshu',
    images: true,
    video: true,
    method: 'Public initial state and original media keys',
    limitations: ['Share tokens may be required', 'Login and verification gates are reported'],
  },
  {
    platform: 'kuaishou',
    images: true,
    video: true,
    method: 'Public manifest/atlas with exact share-alias matching',
    limitations: ['Source availability depends on platform/network'],
  },
  {
    platform: 'tiktok',
    images: true,
    video: true,
    method: 'Public hydration state',
    limitations: ['Regional and verification gates are reported'],
  },
  {
    platform: 'youtube',
    images: false,
    video: true,
    method:
      'Public watch/YouTube.js player, isolated QuickJS transforms, direct MP4 or file-backed H.264/AAC mux',
    limitations: [
      'Only static complete MP4 or compatible H.264/AAC tracks; SABR/HLS/DASH/DRM are unsupported',
      'Some exposed media URLs may still be refused with HTTP 403',
      'Anonymous player access may require platform verification',
      'No mandatory external helpers',
    ],
  },
];
