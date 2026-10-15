import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import {
  emptyCounts,
  type Count,
  type Counts,
  type Media,
  type Platform,
} from '@cleansave/contracts';
import { hash, type AccessSource, type Capture } from '@cleansave/core';
import { approvedUrl } from './input.js';
import { desktopAgent, mobileAgent, type PageSession } from './network.js';

/** A narrowed upstream object; each property remains untrusted until independently checked. */
export type Json = Record<string, unknown>;

/** Copy a non-array object into a plain record, or return an empty record for other values. */
export function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Narrow unknown upstream data to an array without inventing missing entries. */
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read strings or safe integer labels without coercing objects or imprecise numeric IDs. */
export function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
}

/** Read a positive safe integer such as a dimension or byte length; return null otherwise. */
export function integer(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Preserve exact count integers as strings and recognizable rounded labels without extrapolating
 * values.
 */
export function count(value: unknown): Count | null {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0
      ? { kind: 'exact', value: String(value) }
      : null;
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (/^\d+$/.test(label) || /^\d{1,3}(?:,\d{3})+$/.test(label))
    return { kind: 'exact', value: BigInt(label.replaceAll(',', '')).toString() };
  if (/^\d+(?:[.,]\d+)?\s*(?:[kKmMbB]|千|万|萬|亿|億)\+?$/.test(label) || /^\d+\+$/.test(label))
    return { kind: 'rounded', display: label };
  return null;
}

/** Normalize metric fields and optionally treat unpublished zero view counts as unavailable. */
export function statistics(
  fields: Partial<Record<keyof Counts, unknown>>,
  omitZeroViews = false,
): Counts {
  const result = emptyCounts();
  for (const key of Object.keys(result)) {
    const metric = key as keyof Counts;
    result[metric] = count(fields[metric]);
  }
  if (omitZeroViews && result.views?.kind === 'exact' && result.views.value === '0')
    result.views = null;
  return result;
}

/** Quote large integer literals outside strings, preserving platform IDs before JSON parsing. */
export function parseJson(raw: string): unknown {
  let result = '',
    quoted = false,
    escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index] ?? '';
    if (quoted) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      result += character;
      continue;
    }
    const numeric = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(index));
    if (numeric && /[-\d]/.test(character)) {
      const token = numeric[0];
      result += /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token;
      index += token.length - 1;
      continue;
    }
    const missing = /^(?:undefined|NaN|Infinity)\b/.exec(raw.slice(index));
    if (missing) {
      result += 'null';
      index += missing[0].length - 1;
    } else result += character;
  }
  return JSON.parse(result);
}

/** Parse a bounded object assignment from HTML without executing upstream JavaScript. */
export function assignment(html: string, marker: string): unknown | null {
  let from = 0;
  while (from < html.length) {
    const at = html.indexOf(marker, from);
    if (at < 0) return null;
    const start = html.indexOf('{', at + marker.length);
    from = at + marker.length;
    if (start < 0 || start - at > 150) continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let index = start; index < html.length; index++) {
      const character = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try {
          const parsed = parseJson(html.slice(start, index + 1));
          if (Object.keys(object(parsed)).length) return parsed;
        } catch {
          /* Try a later complete assignment. */
        }
        break;
      }
    }
  }
  return null;
}

/** Parse known public hydration script elements, ignoring malformed candidates. */
export function scriptStates(html: string): unknown[] {
  const $ = load(html);
  const result: unknown[] = [];
  $('script').each((_, element) => {
    const id = $(element).attr('id') ?? '';
    if (
      [
        '__UNIVERSAL_DATA_FOR_REHYDRATION__',
        'SIGI_STATE',
        'sigi-persisted-data',
        'api-data',
      ].includes(id)
    ) {
      try {
        result.push(parseJson($(element).text()));
      } catch {
        /* Ignore malformed scripts. */
      }
    }
  });
  return result;
}

/**
 * Search upstream objects breadth-first with a 15,000-node visit bound and an identity predicate.
 */
export function findObject(root: unknown, predicate: (value: Json) => boolean): Json | null {
  const queue: unknown[] = [root];
  for (let index = 0; index < queue.length && index < 15000; index++) {
    const value = queue[index];
    const item = object(value);
    if (Object.keys(item).length) {
      if (predicate(item)) return item;
      queue.push(
        ...Object.values(item).filter((entry) => entry !== null && typeof entry === 'object'),
      );
    } else if (Array.isArray(value)) queue.push(...value);
  }
  return null;
}

/** Extract only approved HTTPS media URLs from known upstream URL containers. */
export function urls(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return [approvedUrl(value.replace(/^http:\/\//, 'https://'), true).toString()];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(urls);
  const item = object(value);
  return urls(
    item.url_list ?? item.UrlList ?? item.urlList ?? item.url ?? item.src ?? item.json ?? [],
  );
}

/** Extract a stable media identity from a video ID or sufficiently distinctive URL path. */
export function sourceKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get('video_id') ||
      (parsed.pathname.split('/').some((part) => /^[\w-]{20,}$/.test(part))
        ? (parsed.pathname.split('!')[0] ?? null)
        : null)
    );
  } catch {
    return null;
  }
}

/** Construct an ordered, identity-pinned media candidate and its private access descriptor. */
export function source(
  postId: string,
  kind: Media['kind'],
  candidates: string[],
  key: string | null,
  position = 0,
  extra: Partial<Media> = {},
): AccessSource {
  const first = candidates[0] ?? '';
  const stable = key || sourceKey(first);
  const media: Media = {
    itemId: hash(
      `${postId}/${kind}/${kind === 'video' ? 'video' : (stable ?? 'missing-' + position)}`,
    ),
    variantId: hash(
      `${stable ?? 'unknown-' + position}/${extra.codec ?? ''}/${extra.width ?? ''}/${extra.height ?? ''}`,
    ),
    sourceKey: stable,
    kind,
    position,
    required: true,
    width: null,
    height: null,
    codec: null,
    expectedBytes: null,
    watermarkStatus: 'clean',
    provenance: 'playback',
    evidence: 'Platform-published playback source',
    ...extra,
  };
  return {
    media,
    urls: candidates,
    referer: '',
    userAgent: kind === 'video' ? desktopAgent : mobileAgent,
  };
}

/**
 * Build a timestamped same-post capture, preserving identifying canonical parameters and scoped
 * referers.
 */
export function captured(
  platform: Platform,
  id: string,
  url: string,
  item: Json,
  sources: AccessSource[],
  counts: Counts,
  title = '',
  description = '',
): Capture {
  const author = object(item.author ?? item.user);
  const canonical = new URL(url);
  canonical.search = '';
  canonical.hash = '';
  // Query parameters can identify the post itself, rather than just share tracking.
  if (platform === 'youtube') {
    canonical.hostname = 'www.youtube.com';
    canonical.pathname = '/watch';
    canonical.searchParams.set('v', id);
  } else if (platform === 'douyin' && !/\/(?:video|note|slides)\//.test(canonical.pathname)) {
    canonical.searchParams.set('modal_id', id);
  } else if (platform === 'kuaishou' && new URL(url).searchParams.has('photoId')) {
    canonical.searchParams.set('photoId', id);
  }
  return {
    platform,
    postId: id,
    metadata: {
      title,
      description,
      canonicalUrl: canonical.toString(),
      author: {
        name: text(author.nickname ?? author.nickName ?? author.name ?? item.userName) || null,
        handle: text(author.uniqueId ?? author.redId ?? author.short_id) || null,
        id: text(author.uid ?? author.userId ?? author.id ?? item.userId) || null,
        profileUrl: null,
      },
      publishedAt: null,
      capturedAt: new Date().toISOString(),
      adapterVersion: `${platform}/0.1.0`,
      warnings: [],
    },
    counts,
    sources: sources.map((entry) => ({ ...entry, referer: `${canonical.origin}/` })),
  };
}

/**
 * Solve a bounded anonymous SHA-256 visitor challenge and set its host-scoped cookie without
 * evaluating scripts.
 */
export function visitorChallenge(
  html: string,
  url: string,
  session: Pick<PageSession, 'setCookie'>,
): boolean {
  const host = new URL(url).hostname;
  if (!/(^|\.)(douyin\.com|iesdouyin\.com|tiktok\.com)$/.test(host)) return false;
  const $ = load(html);
  const constant = (name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*["']([A-Za-z0-9_+/=-]+)["']`).exec(html)?.[1];
  const encoded = $('#cs').attr('class') ?? constant('cs');
  const name = $('#wci').attr('class') ?? constant('wci');
  if (!encoded || !name || encoded.length > 16000 || !/^[\w-]{1,64}$/.test(name)) return false;
  try {
    const data = object(parseJson(Buffer.from(encoded, 'base64').toString('utf8'))),
      value = object(data.v);
    const seed = Buffer.from(text(value.a), 'base64'),
      expected = Buffer.from(text(value.c), 'base64');
    if (!seed.length || seed.length > 128 || expected.length !== 32) return false;
    const start = Date.now();
    for (let number = 0; number <= 1000000; number++) {
      if (number % 4096 === 0 && Date.now() - start > 1500) return false;
      const actual = createHash('sha256').update(seed).update(String(number)).digest();
      if (actual.equals(expected)) {
        data.d = Buffer.from(String(number)).toString('base64');
        session.setCookie(name, Buffer.from(JSON.stringify(data)).toString('base64'), host);
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
