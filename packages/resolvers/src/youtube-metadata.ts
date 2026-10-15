import { load } from 'cheerio';
import { AppError, type Capture } from '@cleansave/core';
import { emptyCounts, type SafeError } from '@cleansave/contracts';
import { captured, object, parseJson, text } from './parsing.js';
import type { PageSession } from './network.js';

/** Public oEmbed supplies partial same-video metadata even when player access is refused. */
export async function youtubeMetadata(
  session: PageSession,
  id: string,
  error: SafeError,
  signal: AbortSignal,
): Promise<Capture | null> {
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(canonical);
  const page = await session.page(url, signal);
  const data = object(parseJson(page.text));
  const iframe = load(text(data.html))('iframe').attr('src');
  if (!iframe) return null;
  const embed = new URL(iframe);
  if (
    embed.protocol !== 'https:' ||
    !['www.youtube.com', 'www.youtube-nocookie.com'].includes(embed.hostname) ||
    embed.pathname !== '/embed/' + id ||
    embed.username ||
    embed.password ||
    (embed.port && embed.port !== '443') ||
    !text(data.title)
  )
    throw new AppError(
      'source_changed',
      'The public metadata did not identify the requested YouTube video.',
      409,
    );
  const result = captured(
    'youtube',
    id,
    canonical,
    { author: { name: text(data.author_name) } },
    [],
    emptyCounts(),
    text(data.title),
  );
  result.metadata.adapterVersion = 'youtube/0.1.0+oembed';
  result.metadata.warnings = ['partial_metadata', 'media_manifest_unavailable', error.code];
  return { ...result, accessError: error };
}
