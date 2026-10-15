import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import { AppError, discardBody, type AccessSource, type HttpResult } from '@cleansave/core';

/** The detected format, byte length, and SHA-256 receipt of a validated staged file. */
export interface VerifiedFile {
  mime: string;
  ext: string;
  bytes: number;
  sha256: string;
}

/** Open a controlled upstream media stream; the transfer owns body disposal and cancellation. */
export type FetchMedia = (
  url: string,
  source: AccessSource,
  signal: AbortSignal,
) => Promise<HttpResult>;

/**
 * Stream a bounded media response into an exclusive staging file, validate it, and try at most
 * three URLs. Failed attempts remove staged bytes.
 */
export async function transferFile(
  fetchMedia: FetchMedia,
  source: AccessSource,
  options: {
    urls: string[];
    expected: number | null;
    kind: 'image' | 'video' | 'audio';
    requireAudio: boolean;
    stage: string;
    ceiling: number;
    signal: AbortSignal;
    progress: (bytes: number) => void;
  },
): Promise<VerifiedFile> {
  let failure: unknown = new AppError(
    'source_unavailable',
    'No usable source address is available.',
    422,
  );
  for (const url of options.urls.slice(0, 3)) {
    try {
      options.signal.throwIfAborted();
      const response = await fetchMedia(url, source, options.signal);
      const refuse = (code: string, message: string, status = 422, retryable = false): never => {
        discardBody(response.body);
        throw new AppError(code, message, status, retryable);
      };
      if (response.status === 403)
        refuse('media_access_refused', 'The platform refused access to the selected media file.');
      if (response.status === 401)
        refuse('source_sign_in_required', 'The platform requires sign-in for this media file.');
      if (response.status === 429)
        refuse('rate_limited', 'The platform limited media requests.', 422, true);
      if (![200, 206].includes(response.status))
        refuse(
          'source_unavailable',
          'The platform did not return a media file.',
          422,
          response.status >= 500 || response.status === 404,
        );
      if (
        response.headers['content-encoding'] &&
        response.headers['content-encoding'] !== 'identity'
      )
        refuse('invalid_media', 'Compressed transfer bytes cannot be retained as original media.');
      let expected = options.expected;
      if (response.status === 206) {
        const match = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '');
        const end = Number(match?.[1]),
          total = Number(match?.[2]);
        if (
          !match ||
          !Number.isSafeInteger(total) ||
          total <= 0 ||
          end !== total - 1 ||
          (expected !== null && expected !== total)
        )
          refuse('invalid_media', 'The platform returned an incomplete byte range.');
        expected = total;
      }
      const raw = response.headers['content-length'];
      if (raw) {
        const length = Number(raw);
        if (
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          (expected !== null && expected !== length)
        )
          refuse('source_changed', 'The source byte length changed.', 409);
        expected = length;
      }
      if (expected !== null && expected > options.ceiling)
        refuse('media_too_large', 'The media exceeds the download limit.', 413);
      let bytes = 0;
      const digest = createHash('sha256');
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > options.ceiling) {
            callback(new AppError('media_too_large', 'The download exceeded its byte limit.', 413));
            return;
          }
          digest.update(chunk);
          options.progress(bytes);
          callback(null, chunk);
        },
      });
      await pipeline(
        response.body,
        meter,
        createWriteStream(options.stage, { flags: 'wx', mode: 0o600 }),
        { signal: options.signal },
      );
      if (!bytes || (expected !== null && expected !== bytes))
        throw new AppError('invalid_media', 'The download was incomplete.', 422);
      const format = await fileTypeFromFile(options.stage);
      const compatible =
        format &&
        (options.kind === 'image'
          ? format.mime.startsWith('image/') && format.mime !== 'image/svg+xml'
          : options.kind === 'audio'
            ? ['audio/mp4', 'video/mp4', 'audio/x-m4a'].includes(format.mime)
            : format.mime.startsWith('video/'));
      if (!format || !compatible)
        throw new AppError('invalid_media', 'The response is not the expected media type.', 422);
      if (['mp4', 'mov', 'm4a', 'm4b'].includes(format.ext))
        await validateMp4(
          options.stage,
          bytes,
          options.kind !== 'audio',
          options.kind === 'audio' || options.requireAudio,
        );
      return { mime: format.mime, ext: format.ext, bytes, sha256: digest.digest('hex') };
    } catch (error) {
      failure = error;
      await rm(options.stage, { force: true });
      if (
        options.signal.aborted ||
        (error instanceof AppError &&
          ['source_changed', 'media_too_large', 'cancelled'].includes(error.code))
      )
        throw error;
    }
  }
  throw failure;
}

/**
 * Check complete MP4 boxes, movie data, and required track markers without loading the media
 * payload.
 */
export async function validateMp4(
  path: string,
  length: number,
  requireVideo: boolean,
  requireAudio: boolean,
): Promise<void> {
  const file = await open(path, 'r');
  let position = 0,
    movie: Buffer | null = null,
    data = false;
  try {
    while (position < length) {
      const header = Buffer.alloc(16);
      const read = await file.read(header, 0, Math.min(16, length - position), position);
      if (read.bytesRead < 8)
        throw new AppError('invalid_media', 'The video container is truncated.', 422);
      let size = header.readUInt32BE(0),
        head = 8;
      if (size === 1) {
        if (read.bytesRead < 16)
          throw new AppError('invalid_media', 'The video box is truncated.', 422);
        const big = header.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER))
          throw new AppError('invalid_media', 'The video container length is invalid.', 422);
        size = Number(big);
        head = 16;
      }
      if (size === 0) size = length - position;
      if (size < head || size > length - position)
        throw new AppError('invalid_media', 'The video container has incomplete boxes.', 422);
      const type = header.toString('ascii', 4, 8);
      if (type === 'mdat') data ||= size > head;
      if (type === 'moov') {
        if (size - head > 16 * 1024 * 1024)
          throw new AppError('unsupported_format', 'The video index exceeds its limit.', 422);
        movie = Buffer.alloc(size - head);
        const loaded = await file.read(movie, 0, movie.length, position + head);
        if (loaded.bytesRead !== movie.length)
          throw new AppError('invalid_media', 'The video index was truncated.', 422);
      }
      position += size;
    }
    if (
      !movie ||
      !data ||
      (requireVideo && !movie.includes(Buffer.from('vide'))) ||
      (requireAudio && !movie.includes(Buffer.from('soun')))
    )
      throw new AppError(
        'invalid_media',
        'The video is missing complete movie data or expected tracks.',
        422,
      );
  } finally {
    await file.close();
  }
}
