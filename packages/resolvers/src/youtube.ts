import { z } from 'zod';
import { AppError, type Capture } from '@cleansave/core';
import { isolatedTask } from '@cleansave/core/task';
import { approvedUrl } from './input.js';
import { array, assignment, object, parseJson, text } from './parsing.js';
import { desktopAgent, type PageSession } from './network.js';
import { parseYouTube } from './platforms.js';
import { youtubeMetadata } from './youtube-metadata.js';
import { youtubeFormatSchema, youtubeUrlsSchema, type YoutubeFormat } from './youtube-task.js';

/** Validate both encrypted input and transformed output; never log signed URLs. */
export function youtubeMediaUrl(
  value: string,
  format: Pick<YoutubeFormat, 'itag' | 'contentLength'>,
): string {
  const url = approvedUrl(value, true);
  if (
    !url.hostname.endsWith('.googlevideo.com') ||
    url.pathname !== '/videoplayback' ||
    url.searchParams.getAll('itag').length !== 1 ||
    url.searchParams.get('itag') !== String(format.itag) ||
    url.searchParams.getAll('clen').length > 1 ||
    (url.searchParams.has('clen') && url.searchParams.get('clen') !== format.contentLength)
  )
    throw new AppError('source_changed', 'YouTube returned a different media variant.', 409);
  return url.toString();
}

function supportedFormats(player: unknown): YoutubeFormat[] {
  const streaming = object(object(player).streamingData);
  if (array(streaming.licenseInfos).length) return [];
  return [...array(streaming.formats), ...array(streaming.adaptiveFormats)]
    .flatMap((raw) => {
      const value = object(raw);
      const mime = text(value.mimeType);
      if (
        value.drmFamilies ||
        value.drmTrackType ||
        value.type === 'FORMAT_STREAM_TYPE_OTF' ||
        !(
          (mime.startsWith('video/mp4') && mime.includes('avc1')) ||
          (mime.startsWith('audio/mp4') && mime.includes('mp4a'))
        )
      )
        return [];
      const parsed = youtubeFormatSchema.safeParse({
        ...value,
        contentLength: text(value.contentLength),
        lastModified: text(value.lastModified),
      });
      if (!parsed.success) return [];
      const format = parsed.data;
      const encoded = format.signatureCipher ?? format.cipher;
      const address = format.url ?? new URLSearchParams(encoded).get('url');
      if (!address) return [];
      youtubeMediaUrl(address, format);
      return [format];
    })
    .slice(0, 64);
}

/** Prefetch public player code and transform pinned format URLs in a bounded QuickJS worker. */
export async function transformYoutubeFormats(
  formats: YoutubeFormat[],
  session: PageSession,
  signal: AbortSignal,
): Promise<YoutubeFormat[]> {
  const needsPlayer = formats.some(
    (format) =>
      format.signatureCipher ||
      format.cipher ||
      (format.url && new URL(format.url).searchParams.has('n')),
  );
  let player: { id: string; source: string } | undefined;
  if (needsPlayer) {
    const api = await session.page('https://www.youtube.com/iframe_api', signal);
    const id = /player\\?\/([\w-]{1,80})\\?\//.exec(api.text)?.[1];
    if (!id)
      throw new AppError(
        'youtube_player_unavailable',
        'YouTube player transforms were unavailable.',
        422,
      );
    const script = await session.page(
      `https://www.youtube.com/s/player/${id}/player_es6.vflset/en_US/base.js`,
      signal,
    );
    player = { id, source: script.text };
  }
  const urls = await isolatedTask(
    new URL('./youtube-worker.js', import.meta.url),
    { kind: 'formats', formats, ...(player ? { player } : {}) },
    youtubeUrlsSchema,
    signal,
    2000,
    256,
  );
  return formats.map((format, index) => {
    const result = urls[index];
    if (!result || result.itag !== format.itag)
      throw new AppError('source_changed', 'YouTube media identity changed.', 409);
    const transformed = { ...format, url: youtubeMediaUrl(result.url, format) };
    delete transformed.signatureCipher;
    delete transformed.cipher;
    return transformed;
  });
}

/** Only anonymous read endpoints used by the Node client are exposed. */
export function youtubeFetch(
  session: PageSession,
  id: string,
  signal: AbortSignal,
  observe: (value: unknown) => void,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = approvedUrl(request.url);
    const path = url.pathname;
    const get = request.method === 'GET' && path === '/sw.js_data';
    const post = request.method === 'POST' && path === '/youtubei/v1/player';
    if (url.hostname !== 'www.youtube.com' || (!get && !post))
      throw new AppError('unsafe_url', 'The YouTube client requested an unsupported endpoint.');
    const headers: Record<string, string> = {};
    for (const name of [
      'user-agent',
      'accept',
      'accept-language',
      'content-type',
      'x-youtube-client-name',
      'x-youtube-client-version',
      'x-goog-visitor-id',
      'origin',
      'referer',
    ]) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const deadline = AbortSignal.any([signal, request.signal]);
    let page;
    if (post) {
      const body = await request.text();
      if (Buffer.byteLength(body) > 65536)
        throw new AppError('upstream_too_large', 'The YouTube request exceeded its limit.', 422);
      const data = parseJson(body);
      if (object(data).videoId !== id)
        throw new AppError('source_changed', 'The YouTube request changed video identity.', 409);
      page = await session.post(url.toString(), data, deadline, headers);
      observe(parseJson(page.text));
    } else page = await session.page(url.toString(), deadline, headers);
    return new Response(page.text, { headers: { 'content-type': 'application/json' } });
  };
}

async function nodePlayer(
  session: PageSession,
  id: string,
  signal: AbortSignal,
  kind: 'WEB' | 'ANDROID_VR' = 'WEB',
): Promise<{ player: unknown; userAgent: string }> {
  const { Innertube, Log, Constants } = await import('youtubei.js');
  Log.setLevel(Log.Level.NONE);
  let raw: unknown;
  const client = await Innertube.create({
    fetch: youtubeFetch(session, id, signal, (value) => {
      raw = value;
    }),
    retrieve_player: false,
    retrieve_innertube_config: false,
    enable_session_cache: false,
    fail_fast: true,
    user_agent: desktopAgent,
  });
  try {
    await client.getBasicInfo(id, { client: kind });
  } catch (error) {
    if (text(object(object(raw).videoDetails).videoId) !== id) throw error;
  }
  return {
    player: raw,
    userAgent: kind === 'ANDROID_VR' ? Constants.CLIENTS.ANDROID_VR.USER_AGENT : desktopAgent,
  };
}

/**
 * Capture anonymous same-video metadata and supported static formats, reporting verification or
 * transport limits.
 */
export async function resolveYoutube(
  session: PageSession,
  id: string,
  page: { text: string; url: string },
  signal: AbortSignal,
): Promise<Capture | null> {
  let player = assignment(page.text, 'ytInitialPlayerResponse');
  let capture: Capture | null = null;
  let refusal: AppError | null = null;
  let blocked = false;
  let userAgent = desktopAgent;
  try {
    capture = parseYouTube(player, id, page.url);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    refusal = error;
  }
  if (!capture || capture.accessError) {
    try {
      const newer = await nodePlayer(session, id, signal);
      const next = parseYouTube(newer.player, id, page.url);
      if (next) {
        capture = capture ? { ...next, metadata: capture.metadata, counts: capture.counts } : next;
        player = newer.player;
        userAgent = newer.userAgent;
        refusal = null;
      }
    } catch (error) {
      blocked =
        error instanceof AppError &&
        ['platform_verification_required', 'source_sign_in_required'].includes(error.code);
      signal.throwIfAborted(); /* Retain the original public response/refusal. */
    }
  }
  if (
    !blocked &&
    capture?.accessError &&
    ['unsupported_transport', 'unsupported_format'].includes(capture.accessError.code)
  ) {
    try {
      const alternate = await nodePlayer(session, id, signal, 'ANDROID_VR');
      const next = parseYouTube(alternate.player, id, page.url);
      if (next && !next.accessError) {
        capture = { ...next, metadata: capture.metadata, counts: capture.counts };
        player = alternate.player;
        userAgent = alternate.userAgent;
      }
    } catch {
      signal.throwIfAborted(); /* One public-client fallback is bounded. */
    }
  }
  if (capture) {
    const capturedMetadata = capture;
    const formats = supportedFormats(player);
    try {
      const transformed = formats.length
        ? await transformYoutubeFormats(formats, session, signal)
        : [];
      const root = object(player),
        streaming = object(root.streamingData);
      capture = parseYouTube(
        {
          ...root,
          streamingData: {
            ...streaming,
            formats: transformed.filter(
              (format) => format.mimeType.includes('avc1') && format.mimeType.includes('mp4a'),
            ),
            adaptiveFormats: transformed.filter(
              (format) => !(format.mimeType.includes('avc1') && format.mimeType.includes('mp4a')),
            ),
          },
        },
        id,
        page.url,
      );
    } catch (error) {
      signal.throwIfAborted();
      capture = {
        ...capturedMetadata,
        sources: [],
        accessError: new AppError(
          'youtube_transform_unavailable',
          'YouTube media URL transforms could not finish safely.',
          422,
        ).safe(),
        metadata: {
          ...capturedMetadata.metadata,
          warnings: [...capturedMetadata.metadata.warnings, 'youtube_transform_unavailable'],
        },
      };
      if (error instanceof AppError && error.code === 'source_changed') throw error;
    }
    if (capture) {
      capture = {
        ...capture,
        counts: capturedMetadata.counts,
        metadata: {
          ...capturedMetadata.metadata,
          warnings: capture.metadata.warnings,
          adapterVersion: 'youtube/0.2.0+youtubei',
        },
        sources: capture.sources.map((source) => ({ ...source, userAgent })),
      };
    }
    return capture;
  }
  if (refusal) {
    try {
      return await youtubeMetadata(session, id, refusal.safe(), signal);
    } catch {
      signal.throwIfAborted();
      throw refusal;
    }
  }
  return null;
}

/** Internal component API; no HTTP/MCP endpoint accepts executable code. */
export async function evaluateYoutubeGuest(code: string, signal: AbortSignal): Promise<unknown> {
  return isolatedTask(
    new URL('./youtube-worker.js', import.meta.url),
    { kind: 'evaluate', code },
    z.unknown(),
    signal,
    2000,
  );
}
