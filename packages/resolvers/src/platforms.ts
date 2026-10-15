import { AppError, hash, type AccessSource, type Capture } from '@cleansave/core';
import {
  captured,
  array,
  object,
  text,
  integer,
  findObject,
  urls,
  source,
  statistics,
  parseJson,
  type Json,
} from './parsing.js';

function videoUrls(value: unknown): string[] {
  return urls(value).map((url) => {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace('/playwm/', '/play/');
    return parsed.toString();
  });
}

/**
 * Parse only the requested Douyin post and preserve primary album slots, including unavailable
 * items.
 */
export function parseDouyin(state: unknown, id: string, url: string): Capture | null {
  const item = findObject(
    state,
    (value) =>
      text(value.aweme_id) === id &&
      (value.video !== undefined ||
        value.images !== undefined ||
        value.image_post_info !== undefined),
  );
  if (!item) return null;
  const video = object(item.video),
    author = object(item.author),
    stats = object(item.statistics);
  const images = array(item.images).length
    ? array(item.images)
    : array(object(item.image_post_info).images);
  const sources: AccessSource[] = [];
  if (images.length)
    images.forEach((raw, position) => {
      const image = object(raw),
        display = object(image.display_image);
      sources.push(
        source(
          id,
          'image',
          urls(image.url_list ?? display.url_list),
          text(image.uri ?? display.uri) || null,
          position,
          {
            provenance: 'original',
            evidence: 'Douyin post image manifest',
            width: integer(image.width ?? display.width),
            height: integer(image.height ?? display.height),
          },
        ),
      );
    });
  else {
    const address = object(video.play_addr),
      key = text(address.uri) || null;
    sources.push(
      source(id, 'video', videoUrls(address), key, 0, {
        width: integer(video.width),
        height: integer(video.height),
        evidence: 'Douyin play_addr for matching aweme_id',
      }),
    );
    for (const raw of array(video.bit_rate)) {
      const rate = object(raw),
        addr = object(rate.play_addr);
      sources.push(
        source(id, 'video', videoUrls(addr), text(addr.uri) || key, 0, {
          codec: rate.is_h265 === 1 ? 'hevc' : 'h264',
          width: integer(addr.width ?? video.width),
          height: integer(addr.height ?? video.height),
          variantId: hash(`${id}/${text(addr.uri)}/${text(rate.gear_name)}`),
          evidence: 'Douyin post bitrate playback variant',
        }),
      );
    }
  }
  const result = captured(
    'douyin',
    id,
    url,
    { ...item, author },
    sources,
    statistics(
      {
        likes: stats.digg_count,
        comments: stats.comment_count,
        shares: stats.share_count,
        favorites: stats.collect_count,
        views: stats.play_count,
      },
      true,
    ),
    '',
    text(item.desc),
  );
  const created = integer(item.create_time);
  if (created) result.metadata.publishedAt = new Date(created * 1000).toISOString();
  return result;
}

/** Match one Xiaohongshu note and prefer original image or video keys over alternate playback. */
export function parseXiaohongshu(state: unknown, id: string, url: string): Capture | null {
  const item = findObject(
    state,
    (value) =>
      text(value.noteId).toLowerCase() === id.toLowerCase() &&
      (value.video !== undefined || value.imageList !== undefined),
  );
  if (!item) return null;
  const video = object(item.video),
    stats = object(item.interactInfo);
  const sources: AccessSource[] = [];
  if (item.type !== 'video')
    array(item.imageList).forEach((raw, position) => {
      const image = object(raw);
      let key = text(image.fileId);
      if (!key) {
        const original = urls(image.urlDefault ?? image.url)[0];
        if (original) {
          const parts = new URL(original).pathname.split('!')[0]?.split('/').filter(Boolean) ?? [];
          if (parts.length > 2) key = parts.slice(2).join('/');
        }
      }
      sources.push(
        source(
          id,
          'image',
          key && /^[\w/-]+$/.test(key) ? [`https://sns-img-bd.xhscdn.com/${key}`] : [],
          key || null,
          position,
          {
            provenance: 'original',
            width: integer(image.width),
            height: integer(image.height),
            evidence: 'Xiaohongshu original image key',
          },
        ),
      );
    });
  else {
    const key = text(object(video.consumer).originVideoKey);
    if (key && /^[\w/-]+$/.test(key))
      sources.push(
        source(id, 'video', [`https://sns-video-bd.xhscdn.com/${key}`], key, 0, {
          provenance: 'original',
          evidence: 'Xiaohongshu originVideoKey',
        }),
      );
    for (const raw of Object.values(object(object(video.media).stream)).flatMap(array)) {
      const stream = object(raw);
      const candidates = [...urls(stream.masterUrl), ...urls(stream.backupUrls)];
      sources.push(
        source(id, 'video', candidates, null, 0, {
          width: integer(stream.width),
          height: integer(stream.height),
          codec: text(stream.videoCodec) || null,
          watermarkStatus: 'unknown',
          evidence: 'Xiaohongshu alternate playback; watermark status unknown',
        }),
      );
    }
  }
  return captured(
    'xiaohongshu',
    id,
    url,
    item,
    sources,
    statistics({
      likes: stats.likedCount,
      comments: stats.commentCount,
      shares: stats.shareCount ?? stats.sharedCount,
      favorites: stats.collectedCount,
    }),
    text(item.title),
    text(item.desc),
  );
}

/** Match one TikTok post, keeping scoped counts, ordered images, and eligible video variants. */
export function parseTikTok(state: unknown, id: string, url: string): Capture | null {
  const item = findObject(
    state,
    (value) =>
      text(value.id) === id && (value.video !== undefined || value.imagePost !== undefined),
  );
  if (!item) return null;
  const video = object(item.video),
    stats = object(item.stats),
    statsV2 = object(item.statsV2);
  const images = array(object(item.imagePost).images),
    sources: AccessSource[] = [];
  if (images.length)
    images.forEach((raw, position) => {
      const image = object(raw);
      const candidates = urls(object(image.imageURL).urlList ?? object(image.imageURL).url_list);
      sources.push(
        source(id, 'image', candidates, text(image.imageId) || null, position, {
          evidence: 'TikTok imagePost playback manifest',
        }),
      );
    });
  else {
    for (const raw of array(video.bitrateInfo)) {
      const rate = object(raw),
        address = object(rate.PlayAddr),
        key = text(address.UrlKey);
      const candidates = urls(address.UrlList);
      if (key.includes('bytevc2') || candidates[0]?.includes('/media-video-hvc1/')) continue;
      sources.push(
        source(id, 'video', candidates, key || null, 0, {
          codec: /bytevc1|h265|hevc/i.test(key) ? 'hevc' : 'h264',
          expectedBytes: integer(address.DataSize),
          variantId: hash(`${id}/${key}`),
          evidence: 'TikTok PlayAddr bitrate variant',
        }),
      );
    }
    sources.push(
      source(id, 'video', urls(video.playAddr), text(video.id) || null, 0, {
        width: integer(video.width),
        height: integer(video.height),
        evidence: 'TikTok post video.playAddr',
      }),
    );
    if (!sources.some((entry) => entry.urls.length))
      sources.push(
        source(id, 'video', urls(video.downloadAddr), text(video.id) || null, 0, {
          watermarkStatus: 'watermarked',
          provenance: 'download',
          evidence: 'TikTok downloadAddr export',
        }),
      );
  }
  return captured(
    'tiktok',
    id,
    url,
    item,
    sources,
    statistics({
      likes: statsV2.diggCount ?? stats.diggCount,
      comments: statsV2.commentCount ?? stats.commentCount,
      shares: statsV2.shareCount ?? stats.shareCount,
      favorites: statsV2.collectCount ?? stats.collectCount,
      views: statsV2.playCount ?? stats.playCount,
    }),
    '',
    text(item.desc),
  );
}

/** Match all requested Kuaishou aliases to one post before parsing its manifest or image atlas. */
export function parseKuaishou(state: unknown, ids: string[], url: string): Capture | null {
  const root = object(state),
    client = object(root.defaultClient ?? state);
  const dereference = (value: unknown): Json => {
    for (let depth = 0; depth < 12; depth++) {
      const item = object(value),
        ref = item.__ref ?? (item.type === 'id' ? item.id : null);
      if (!ref || !client[text(ref)]) return item;
      value = client[text(ref)];
    }
    return {};
  };
  const item = findObject(state, (value) => {
    if (!value.manifest && !value.manifestH265 && !object(value.ext_params).atlas) return false;
    const aliases = [text(value.photoId ?? value.id)];
    if (typeof value.share_info === 'string')
      aliases.push(new URLSearchParams(value.share_info).get('photoId') ?? '');
    else aliases.push(text(object(value.share_info).photoId));
    return ids.every((id) => aliases.includes(id));
  });
  if (!item) return null;
  const id = text(item.photoId ?? item.id);
  if (!id) return null;
  const sources: AccessSource[] = [],
    atlas = object(object(item.ext_params).atlas);
  const images = array(atlas.list);
  if (images.length)
    images.forEach((raw, position) => {
      const path = text(raw);
      const candidates = array(atlas.cdnList).flatMap((host) =>
        urls(`https://${typeof host === 'string' ? host : text(object(host).cdn)}/${path}`),
      );
      sources.push(
        source(id, 'image', candidates, path || null, position, {
          provenance: 'original',
          evidence: 'Kuaishou atlas original image',
        }),
      );
    });
  else
    for (const field of ['manifest', 'manifestH265']) {
      let manifest: unknown = dereference(item[field]);
      if (typeof item[field] === 'string') {
        try {
          manifest = parseJson(item[field]);
        } catch {
          continue;
        }
      }
      if (object(manifest).json) {
        try {
          manifest = parseJson(text(object(manifest).json));
        } catch {
          continue;
        }
      }
      for (const set of array(object(manifest).adaptationSet))
        for (const raw of array(dereference(set).representation)) {
          const representation = dereference(raw);
          if (representation.hidden === true) continue;
          const candidates = [...urls(representation.url), ...urls(representation.backupUrl)];
          sources.push(
            source(
              id,
              'video',
              candidates,
              text(representation.id) ? `${id}/${text(representation.id)}` : null,
              0,
              {
                codec: field === 'manifestH265' ? 'hevc' : 'h264',
                width: integer(representation.width),
                height: integer(representation.height),
                evidence: 'Kuaishou post manifest representation',
              },
            ),
          );
        }
    }
  const author = dereference(item.user ?? item.author);
  const stats = object(item.counts ?? item.statistics);
  return captured(
    'kuaishou',
    id,
    url,
    {
      ...item,
      author: { ...author, name: author.name ?? item.userName, id: author.id ?? item.userId },
    },
    sources,
    statistics({
      likes: item.likeCount ?? stats.likeCount,
      comments: item.commentCount ?? stats.commentCount,
      shares: item.shareCount ?? stats.shareCount,
      favorites: item.collectCount ?? stats.collectCount,
      views: item.viewCount ?? stats.viewCount,
    }),
    '',
    text(item.caption ?? item.title),
  );
}

/**
 * Validate video identity and public playability, then select static combined MP4 or compatible
 * track pairs.
 */
export function parseYouTube(player: unknown, id: string, url: string): Capture | null {
  const response = object(player),
    status = object(response.playabilityStatus),
    details = object(response.videoDetails);
  if (details.videoId && text(details.videoId) !== id) return null;
  if (status.status === 'LOGIN_REQUIRED')
    throw new AppError(
      /bot|confirm|verif/i.test(text(status.reason))
        ? 'platform_verification_required'
        : 'source_sign_in_required',
      'YouTube requires sign-in or verification for this source.',
      422,
    );
  if (
    (status.status && status.status !== 'OK') ||
    details.isPrivate === true ||
    details.isLive === true
  )
    throw new AppError(
      'post_unavailable',
      'This public video is unavailable or is currently live.',
      422,
    );
  if (text(details.videoId) !== id) return null;
  const streaming = object(response.streamingData),
    sources: AccessSource[] = [];
  if (!array(streaming.licenseInfos).length)
    for (const raw of array(streaming.formats)) {
      const format = object(raw),
        mime = text(format.mimeType),
        itag = integer(format.itag),
        length = integer(format.contentLength),
        modified = text(format.lastModified);
      if (
        !mime.startsWith('video/mp4') ||
        !mime.includes('avc1') ||
        !mime.includes('mp4a') ||
        !itag ||
        !length ||
        !/^\d+$/.test(modified) ||
        format.signatureCipher ||
        format.cipher ||
        format.drmFamilies ||
        format.drmTrackType
      )
        continue;
      const candidates = urls(format.url).filter((address) => {
        const parsed = new URL(address);
        return (
          parsed.hostname.endsWith('.googlevideo.com') &&
          parsed.pathname === '/videoplayback' &&
          parsed.searchParams.get('itag') === String(itag) &&
          (!parsed.searchParams.has('clen') || parsed.searchParams.get('clen') === String(length))
        );
      });
      const identity = `youtube:${id}:${itag}:${modified}:${length}`;
      sources.push(
        source(id, 'video', candidates, identity, 0, {
          codec: 'h264/aac',
          width: integer(format.width),
          height: integer(format.height),
          expectedBytes: length,
          evidence: 'YouTube combined H.264/AAC format with explicit direct URL',
        }),
      );
    }
  if (!array(streaming.licenseInfos).length) {
    const tracks = array(streaming.adaptiveFormats)
      .map(object)
      .filter(
        (format) =>
          !format.drmFamilies &&
          !format.drmTrackType &&
          !format.signatureCipher &&
          !format.cipher &&
          format.type !== 'FORMAT_STREAM_TYPE_OTF' &&
          integer(format.itag) &&
          integer(format.contentLength) &&
          /^\d+$/.test(text(format.lastModified)) &&
          urls(format.url).some((address) => {
            const target = new URL(address);
            return (
              target.hostname.endsWith('.googlevideo.com') &&
              target.pathname === '/videoplayback' &&
              target.searchParams.get('itag') === String(format.itag) &&
              (!target.searchParams.has('clen') ||
                target.searchParams.get('clen') === String(format.contentLength))
            );
          }),
      );
    const videos = tracks
      .filter(
        (track) =>
          text(track.mimeType).startsWith('video/mp4') &&
          text(track.mimeType).includes('avc1') &&
          !text(track.mimeType).includes('mp4a'),
      )
      .sort((a, b) => (integer(b.height) ?? 0) - (integer(a.height) ?? 0));
    const audios = tracks
      .filter(
        (track) =>
          text(track.mimeType).startsWith('audio/mp4') &&
          text(track.mimeType).includes('mp4a') &&
          object(track.audioTrack).audioIsDefault !== false,
      )
      .sort(
        (a, b) =>
          Number(object(b.audioTrack).audioIsDefault === true) -
            Number(object(a.audioTrack).audioIsDefault === true) ||
          (integer(b.bitrate) ?? 0) - (integer(a.bitrate) ?? 0),
      );
    for (const video of videos.slice(0, 32))
      for (const audio of audios.slice(0, 2)) {
        const key = (track: Json): string =>
          `youtube:${id}:${text(track.itag)}:${text(track.lastModified)}:${text(track.contentLength)}`;
        const videoKey = key(video),
          audioKey = key(audio);
        const combined = source(id, 'video', [], videoKey + '+' + audioKey, 0, {
          codec: 'h264/aac',
          width: integer(video.width),
          height: integer(video.height),
          provenance: 'derived_mux',
          evidence: 'Same-video H.264 and AAC tracks; remuxed MP4 container without re-encoding',
        });
        combined.plan = {
          kind: 'mux',
          parts: [
            {
              role: 'video',
              variantId: hash(videoKey),
              sourceKey: videoKey,
              expectedBytes: Number(video.contentLength),
              urls: urls(video.url),
            },
            {
              role: 'audio',
              variantId: hash(audioKey),
              sourceKey: audioKey,
              expectedBytes: Number(audio.contentLength),
              urls: urls(audio.url),
            },
          ],
        };
        sources.push(combined);
      }
  }
  const micro = object(object(response.microformat).playerMicroformatRenderer);
  const scoped = text(micro.externalVideoId) === id ? micro : {};
  const capture = captured(
    'youtube',
    id,
    url,
    { author: { name: details.author, id: details.channelId } },
    sources,
    statistics({
      views: details.viewCount,
      likes: details.likeCount ?? scoped.likeCount,
      comments: details.commentCount ?? scoped.commentCount,
    }),
    text(details.title),
    text(details.shortDescription),
  );
  if (!sources.some((entry) => entry.urls.length || entry.plan)) {
    const code =
      streaming.serverAbrStreamingUrl || streaming.hlsManifestUrl || streaming.dashManifestUrl
        ? 'unsupported_transport'
        : 'unsupported_format';
    capture.metadata.warnings.push(code);
    capture.accessError = new AppError(
      code,
      'No supported complete YouTube file or compatible track pair was exposed.',
      422,
    ).safe();
  }
  return capture;
}
