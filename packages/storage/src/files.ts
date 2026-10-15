import { randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { assetSchema, inputReceiptSchema, type Asset, type RecordDto } from '@cleansave/contracts';
import { isolatedTask } from '@cleansave/core/task';
import { transferFile, validateMp4, type VerifiedFile } from './transfer.js';
import { muxResultSchema } from './mux-task.js';
import {
  AppError,
  publicRecord,
  type AccessSource,
  type HttpResult,
  type MediaFiles,
  type StoredJob,
  type StoredRecord,
} from '@cleansave/core';

/**
 * Stage, verify, and atomically adopt owned media files with per-record filesystem serialization.
 */
export class FileStore implements MediaFiles {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Use an owned data root, controlled media transport, and current-record lookup for adoption
   * fencing.
   */
  constructor(
    public readonly root: string,
    private readonly fetchMedia: (
      url: string,
      source: AccessSource,
      signal: AbortSignal,
    ) => Promise<HttpResult>,
    private readonly current: (id: string) => Promise<StoredRecord | null>,
  ) {}

  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(id, next);
    await before;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  /** Resolve an existing regular file and enforce realpath containment within the owned library. */
  public async ownedPath(path: string): Promise<string> {
    if (
      path.includes('\\') ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '..' || part === '.')
    )
      throw new AppError('invalid_storage_path', 'The file path is invalid.', 500);
    const base = await realpath(this.root);
    const target = await realpath(join(base, path));
    const rest = relative(base, target);
    if (
      !rest ||
      rest.startsWith('..' + sep) ||
      rest === '..' ||
      rest.startsWith(sep) ||
      !(await lstat(target)).isFile()
    )
      throw new AppError('invalid_storage_path', 'The file is outside the library.', 500);
    return target;
  }

  /** Check owned-file availability and, when supplied, its retained byte length. */
  public async inspect(path: string, expectedBytes?: number): Promise<boolean> {
    try {
      const owned = await this.ownedPath(path);
      return expectedBytes === undefined || (await stat(owned)).size === expectedBytes;
    } catch {
      return false;
    }
  }

  /**
   * Stream and verify a source into staging, returning explicit adopt/discard operations and
   * integrity receipts.
   */
  public async retain(
    job: StoredJob,
    record: StoredRecord,
    source: AccessSource,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<Awaited<ReturnType<MediaFiles['retain']>>> {
    return this.exclusive(record.id, async () => {
      const owner = await this.current(record.id);
      if (!owner || owner.lifecycle !== 'active' || owner.generation !== job.generation)
        throw new AppError('cancelled', 'This download was superseded.', 409);
      const folder = join(this.root, 'staging', record.id, job.id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const id = randomUUID(),
        stage = join(folder, id + '.part');
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
      const ceiling = Math.min(1024 ** 3, 5 * 1024 ** 3 - job.bytes);
      const inputPaths: string[] = [];
      try {
        let verified: VerifiedFile;
        const inputReceipts: Asset['inputReceipts'] = [];
        if (source.plan) {
          const [video, audio] = source.plan.parts;
          if (
            video.role !== 'video' ||
            audio.role !== 'audio' ||
            !Number.isSafeInteger(video.expectedBytes) ||
            !Number.isSafeInteger(audio.expectedBytes) ||
            video.expectedBytes <= 0 ||
            audio.expectedBytes <= 0 ||
            video.expectedBytes + audio.expectedBytes > ceiling
          )
            throw new AppError(
              'invalid_download_plan',
              'The track plan is invalid or exceeds its byte limit.',
              422,
            );
          let completed = 0;
          for (const part of [video, audio]) {
            const path = join(folder, id + '-' + part.role + '.part');
            inputPaths.push(path);
            const input = await transferFile(this.fetchMedia, source, {
              urls: part.urls,
              expected: part.expectedBytes,
              kind: part.role,
              requireAudio: false,
              stage: path,
              ceiling: ceiling - completed,
              signal: deadline,
              progress: (count) => progress(completed + count),
            });
            completed += input.bytes;
            inputReceipts.push(
              inputReceiptSchema.parse({
                role: part.role,
                variantId: part.variantId,
                sourceKey: part.sourceKey,
                bytes: input.bytes,
                sha256: input.sha256,
              }),
            );
          }
          const videoPath = inputPaths[0],
            audioPath = inputPaths[1];
          if (!videoPath || !audioPath)
            throw new AppError('invalid_download_plan', 'The track files are missing.', 422);
          const muxed = await isolatedTask(
            new URL('./mux-worker.js', import.meta.url),
            { video: videoPath, audio: audioPath, output: stage, maxBytes: ceiling },
            muxResultSchema,
            deadline,
            60000,
          );
          await validateMp4(stage, muxed.bytes, true, true);
          verified = { mime: 'video/mp4', ext: 'mp4', bytes: muxed.bytes, sha256: muxed.sha256 };
        } else {
          if (source.media.provenance === 'derived_mux')
            throw new AppError('invalid_download_plan', 'The track plan is missing.', 422);
          const expected =
            record.media.find(
              (media) =>
                media.itemId === source.media.itemId && media.variantId === source.media.variantId,
            )?.expectedBytes ?? source.media.expectedBytes;
          verified = await transferFile(this.fetchMedia, source, {
            urls: source.urls,
            expected,
            kind: source.media.kind,
            requireAudio: source.media.codec === 'h264/aac',
            stage,
            ceiling,
            signal: deadline,
            progress,
          });
        }
        deadline.throwIfAborted();
        const file = await open(stage, 'r');
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        const relativePath = `records/${record.id}/media/${id}.${verified.ext}`;
        const target = join(this.root, relativePath);
        const asset: Asset = assetSchema.parse({
          id,
          recordId: record.id,
          itemId: source.media.itemId,
          variantId: source.media.variantId,
          kind: source.media.kind,
          state: 'complete',
          mime: verified.mime,
          bytes: verified.bytes,
          sha256: verified.sha256,
          completedAt: new Date().toISOString(),
          watermarkStatus: source.media.watermarkStatus,
          required: source.media.required,
          validation: source.plan
            ? 'input-receipts-packets-timing-container'
            : source.media.kind === 'image'
              ? 'signature-length'
              : 'signature-length-container',
          provenance: source.plan ? 'derived_mux' : 'direct',
          inputReceipts,
        });
        return {
          asset,
          relativePath,
          adopt: () =>
            this.exclusive(record.id, async () => {
              const current = await this.current(record.id);
              if (
                !current ||
                current.lifecycle !== 'active' ||
                current.generation !== job.generation
              )
                throw new AppError('cancelled', 'The record changed before file adoption.', 409);
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              const base = await realpath(this.root),
                destination = await realpath(dirname(target));
              if (!destination.startsWith(base + sep))
                throw new AppError(
                  'invalid_storage_path',
                  'The destination escapes the library.',
                  500,
                );
              try {
                await access(target);
                throw new AppError('storage_collision', 'The file already exists.', 409);
              } catch (error) {
                if (!(
                  error !== null &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === 'ENOENT'
                ))
                  throw error;
              }
              await rename(stage, target);
            }),
          discard: async () => {
            await rm(stage, { force: true });
            await rm(target, { force: true });
          },
        };
      } catch (error) {
        await rm(stage, { force: true });
        throw error;
      } finally {
        for (const path of inputPaths) await rm(path, { force: true });
      }
    });
  }

  /** Remove the record-owned directory and staging bytes under the per-record file lock. */
  public async removeRecord(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      await rm(join(this.root, 'records', id), { recursive: true, force: true });
      await rm(join(this.root, 'staging', id), { recursive: true, force: true });
    });
  }

  /** Remove owned downloaded bytes while preserving metadata, annotations, and count history. */
  public async removeDownloads(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      await rm(join(this.root, 'records', id, 'media'), { recursive: true, force: true });
      await rm(join(this.root, 'staging', id), { recursive: true, force: true });
    });
  }

  /**
   * Atomically export current public record data as a derived manifest; SQLite remains
   * authoritative.
   */
  public async manifest(record: RecordDto): Promise<void> {
    await this.exclusive(record.id, async () => {
      const current = await this.current(record.id);
      if (!current || current.lifecycle !== 'active') return;
      const folder = join(this.root, 'records', record.id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const target = join(folder, 'manifest.json'),
        stage = join(folder, `${randomUUID()}.tmp`);
      await writeFile(
        stage,
        JSON.stringify({ version: 1, record: publicRecord(current) }, null, 2),
        { mode: 0o600 },
      );
      await rename(stage, target);
    });
  }
}
