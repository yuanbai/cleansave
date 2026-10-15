import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  jobSchema,
  recordSchema,
  type Counts,
  type Media,
  type Metadata,
  type Platform,
  type RecordDto,
  type SafeError,
  type ListQuery,
  type HistoryQuery,
  type CountCapture,
  type Accepted,
} from '@cleansave/contracts';

/** An operational failure whose code and message are safe to expose to API and MCP callers. */
export class AppError extends Error {
  /**
   * Describe a safe operational failure; status defaults to 400 and retryable defaults to false.
   */
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }

  /** Return only the public error code, message, and retryability flag. */
  public safe(): SafeError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Expose known operational failures and redact unexpected exception details. */
export function safeError(error: unknown): SafeError {
  return error instanceof AppError
    ? error.safe()
    : {
        code: 'operation_failed',
        message: 'The operation could not finish. Check the local service and retry.',
        retryable: true,
      };
}

/** Return a SHA-256 hex digest for a stable identity or request fingerprint. */
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Discarding an unread HTTP body can emit an asynchronous abort error. */
export function discardBody(body: Readable): void {
  body.once('error', () => {
    /* Intentional disposal: callers already handle the status/redirect. */
  });
  body.destroy();
}

/** Normalize Unicode and whitespace, drop empty tags, and retain first-occurrence order. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.normalize('NFKC').trim()).filter(Boolean))];
}

/** A transient, identity-pinned video or audio input for a derived MP4. */
export interface AccessPart {
  role: 'video' | 'audio';
  variantId: string;
  sourceKey: string;
  expectedBytes: number;
  urls: string[];
}

/**
 * Private download access, including expiring URLs and anonymous cookies; never serialize publicly.
 */
export interface AccessSource {
  media: Media;
  urls: string[];
  referer: string;
  userAgent: string;
  cookies?: string;
  plan?: { kind: 'mux'; parts: [AccessPart, AccessPart] };
}

/** A streaming upstream response; its caller must consume or discard the body. */
export interface HttpResult {
  body: Readable;
  headers: Record<string, string>;
  status: number;
  url: string;
}

/**
 * A same-post metadata observation and transient media access; accessError may prevent downloads.
 */
export interface Capture {
  accessError?: SafeError;
  platform: Platform;
  postId: string;
  metadata: Metadata;
  counts: Counts;
  sources: AccessSource[];
}

/** Resolve a public share URL with cancellation and without retaining primary media bytes. */
export interface Resolver {
  /**
   * Resolve a source link with cancellation; this operation does not download primary media bytes.
   */
  resolve(url: string, signal: AbortSignal): Promise<Capture>;
}

/** Validate the persisted record envelope, including private identity and generation fencing. */
export const storedRecordSchema = recordSchema.extend({
  generation: z.number().int().nonnegative(),
  originalInput: z.string(),
  sourceUrls: z.array(z.url()),
  fingerprint: z.string(),
  lifecycle: z.enum(['active', 'merged', 'deleting']),
});

/** A persisted record with private source history and lifecycle state. */
export type StoredRecord = z.infer<typeof storedRecordSchema>;

/** Validate durable job intent, capture revision, generation, and recovery lease. */
export const storedJobSchema = jobSchema.extend({
  generation: z.number().int().nonnegative(),
  requireNoWatermark: z.boolean(),
  metadataRevision: z.number().int().nonnegative(),
  leaseUntil: z.iso.datetime().nullable(),
});

/** A durable operation whose source policy survives retries and process restarts. */
export type StoredJob = z.infer<typeof storedJobSchema>;

/** Allowlist the public record contract, stripping private source inputs and lifecycle fields. */
export function publicRecord(record: StoredRecord): RecordDto {
  return recordSchema.parse(
    Object.fromEntries(
      Object.entries(record).filter(
        ([key]) =>
          !['generation', 'originalInput', 'sourceUrls', 'fingerprint', 'lifecycle'].includes(key),
      ),
    ),
  );
}

/** Transactional persistence boundary for records, immutable count observations, and jobs. */
export interface LibraryRepository {
  /**
   * Save or reuse a record with explicit media intent; replay matching idempotency keys and reject
   * conflicting reuse.
   */
  create(
    input: {
      input: string;
      url: string;
      platform: Platform;
      downloadContent: boolean;
      requireNoWatermark: boolean;
    },
    key: string | null,
  ): Promise<Accepted>;

  /** Read a persisted record with its active job IDs; throw record_not_found when absent. */
  get(id: string): Promise<StoredRecord>;

  /** Browse active stored records with a cursor bound to the filters and ordering. */
  list(query: ListQuery): Promise<{ items: StoredRecord[]; nextCursor: string | null }>;

  /** Page immutable count observations within an inclusive-from, exclusive-to time window. */
  history(
    id: string,
    query: HistoryQuery,
  ): Promise<{ items: CountCapture[]; nextCursor: string | null }>;

  /** Apply personal edits only if the expected annotation revision still matches. */
  annotate(
    id: string,
    input: { note?: string; tags?: string[]; expectedRevision: number },
  ): Promise<StoredRecord>;

  /**
   * Queue durable operation intent, coalesce active equivalents, and reject conflicting policy or
   * idempotency keys.
   */
  enqueue(id: string, type: StoredJob['type'], policy?: boolean, key?: string): Promise<StoredJob>;

  /**
   * Transactionally claim the oldest runnable job, allowing independent metadata refresh and
   * download work.
   */
  claim(): Promise<StoredJob | null>;

  /** Read durable operation intent, progress, and terminal error state. */
  getJob(id: string): Promise<StoredJob>;

  /** Return up to 100 recent jobs in reverse creation order. */
  jobs(): Promise<StoredJob[]>;

  /** Persist a job update unless cancellation has already made it terminal. */
  updateJob(job: StoredJob): Promise<void>;

  /**
   * Atomically replace source metadata and append one count observation, or merge a duplicate post
   * without a new observation.
   */
  capture(job: StoredJob, capture: Capture): Promise<string>;

  /** Pin the first verified primary manifest when an earlier metadata-only capture had none. */
  pinMedia(job: StoredJob, capture: Capture): Promise<StoredRecord>;

  /** Apply a record mutation only while its active lifecycle and generation still match. */
  mutate(
    id: string,
    generation: number,
    fn: (record: StoredRecord) => StoredRecord,
  ): Promise<StoredRecord | null>;

  /**
   * Cancel active resolution, download, or refresh while preserving completed files and historical
   * counts.
   */
  cancel(id: string): Promise<StoredJob>;

  /**
   * Journal file adoption, invoke the rename outside SQLite, then commit the receipt if the
   * generation remains current.
   */
  finalize(
    job: StoredJob,
    asset: RecordDto['assets'][number],
    relativePath: string,
    adopt: () => Promise<void>,
  ): Promise<boolean>;

  /** Read a complete owned asset and its relative path; reject missing or deleting records. */
  assetPath(id: string): Promise<{ asset: RecordDto['assets'][number]; relativePath: string }>;

  /** Commit record deletion and cascade its count observations and retained-file receipts. */
  deleteRecord(id: string): Promise<void>;

  /** Commit removal of retained-file receipts while keeping the record and count observations. */
  removeAssets(id: string): Promise<void>;

  /** Release resources owned by this instance; callers must not reuse it afterward. */
  close(): Promise<void>;
}

/** Owned-file boundary: stage verified bytes, adopt atomically, and export derived manifests. */
export interface MediaFiles {
  /**
   * Stream and verify a source into staging, returning explicit adopt/discard operations and
   * integrity receipts.
   */
  retain(
    job: StoredJob,
    record: StoredRecord,
    source: AccessSource,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<{
    asset: RecordDto['assets'][number];
    relativePath: string;
    adopt: () => Promise<void>;
    discard: () => Promise<void>;
  }>;

  /** Remove the record-owned directory and staging bytes under the per-record file lock. */
  removeRecord(id: string): Promise<void>;

  /** Remove owned downloaded bytes while preserving metadata, annotations, and count history. */
  removeDownloads(id: string): Promise<void>;

  /** Check owned-file availability and, when supplied, its retained byte length. */
  inspect(relativePath: string, expectedBytes?: number): Promise<boolean>;

  /**
   * Atomically export current public record data as a derived manifest; SQLite remains
   * authoritative.
   */
  manifest(record: RecordDto): Promise<void>;
}

/** Run at most two library jobs concurrently while fencing cancelled or superseded work. */
export class Worker {
  private readonly running = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private draining = false;
  private drainAgain = false;
  private stopped = false;
  /** Last redacted background scheduling failure, if any. */
  public lastFailure: SafeError | null = null;

  /**
   * Use explicit persistence, resolver, file storage, and optional safe change-notification
   * dependencies.
   */
  constructor(
    private readonly repo: LibraryRepository,
    private readonly resolver: Resolver,
    private readonly files: MediaFiles,
    private readonly changed: (recordId: string, jobId: string) => void = () => {},
  ) {}

  /** Fill available job slots; background scheduling failures are retained in lastFailure. */
  public kick(): void {
    if (this.stopped) return;
    this.drainAgain = true;
    if (!this.draining)
      void this.drain().catch((error) => {
        this.lastFailure = safeError(error);
      });
  }

  /**
   * Stop accepting jobs, abort active work, and wait for the worker to drain before closing
   * storage.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.running.values()) controller.abort();
    while (this.draining || this.tasks.size)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /**
   * Cancel active resolution, download, or refresh while preserving completed files and historical
   * counts.
   */
  public async cancel(id: string): Promise<StoredJob> {
    const job = await this.repo.cancel(id);
    this.running.get(id)?.abort();
    this.changed(job.recordId, id);
    return job;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.drainAgain && !this.stopped) {
        this.drainAgain = false;
        while (this.tasks.size < 2 && !this.stopped) {
          const job = await this.repo.claim();
          if (!job) break;
          if (this.stopped) {
            await this.repo.updateJob({
              ...job,
              state: 'interrupted',
              updatedAt: new Date().toISOString(),
              leaseUntil: null,
            });
            break;
          }
          const task = this.run(job)
            .catch((error) => {
              this.lastFailure = safeError(error);
            })
            .finally(() => {
              this.tasks.delete(task);
              this.kick();
            });
          this.tasks.add(task);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(job: StoredJob): Promise<void> {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    this.changed(job.recordId, job.id);
    try {
      const record = await this.repo.get(job.recordId);
      if (job.type !== 'refresh' && record.generation !== job.generation)
        throw new AppError('cancelled', 'This operation was superseded.', 409);
      if (job.type === 'delete' || job.type === 'remove_downloads') {
        if (job.type === 'delete') await this.files.removeRecord(record.id);
        else await this.files.removeDownloads(record.id);
        if (job.type === 'delete') await this.repo.deleteRecord(record.id);
        else await this.repo.removeAssets(record.id);
      } else if (job.type === 'resolve' || job.type === 'refresh') {
        const capture = await this.resolver.resolve(
          record.sourceUrls.at(-1) ?? record.originalUrl,
          controller.signal,
        );
        if (controller.signal.aborted)
          throw new AppError('cancelled', 'The operation was cancelled.', 409);
        if (job.type === 'refresh' && capture.metadata.warnings.includes('partial_metadata')) {
          const failure = capture.accessError;
          throw new AppError(
            failure?.code ?? 'metadata_unavailable',
            failure?.message ?? 'A complete metadata capture is currently unavailable.',
            422,
            failure?.retryable ?? true,
          );
        }
        job.recordId = await this.repo.capture(job, capture);
        // Read current intent even when a duplicate paste changed it during resolution.
        const intent = await this.repo.get(record.id);
        if (job.type === 'resolve' && intent.options.downloadContent)
          await this.repo.enqueue(job.recordId, 'download', intent.options.requireNoWatermark);
      } else {
        await this.download(job, record, controller.signal);
      }
      const currentJob = await this.repo.getJob(job.id);
      if (currentJob.state !== 'cancelled')
        await this.repo.updateJob({
          ...job,
          state: 'succeeded',
          updatedAt: new Date().toISOString(),
          leaseUntil: null,
        });
      if (job.type !== 'delete') {
        try {
          await this.files.manifest(publicRecord(await this.repo.get(job.recordId)));
        } catch {
          /* Derived manifests do not invalidate committed records. */
        }
      }
    } catch (error) {
      const failure = controller.signal.aborted
        ? new AppError('cancelled', 'The operation was cancelled.', 409).safe()
        : safeError(error);
      const currentJob = await this.repo.getJob(job.id);
      if (currentJob.state !== 'cancelled') {
        await this.repo.updateJob({
          ...job,
          state: controller.signal.aborted ? 'interrupted' : 'failed',
          error: failure,
          updatedAt: new Date().toISOString(),
          leaseUntil: null,
        });
        const generation =
          job.type === 'refresh' ? (await this.repo.get(job.recordId)).generation : job.generation;
        await this.repo.mutate(job.recordId, generation, (current) =>
          job.type === 'refresh'
            ? { ...current, refreshError: failure }
            : job.type === 'download'
              ? {
                  ...current,
                  error: failure,
                  downloadState: current.assets.some(
                    (asset) => asset.required && asset.state === 'complete',
                  )
                    ? 'partial'
                    : 'failed',
                }
              : {
                  ...current,
                  resolutionState: current.metadata ? current.resolutionState : 'failed',
                  downloadState:
                    !current.metadata && current.options.downloadContent
                      ? 'failed'
                      : current.downloadState,
                  error: failure,
                },
        );
      }
    } finally {
      this.running.delete(job.id);
      this.changed(job.recordId, job.id);
    }
  }

  private async download(
    job: StoredJob,
    original: StoredRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (!original.metadata || !original.postId)
      throw new AppError('metadata_not_available', 'Resolve the record before downloading.', 409);
    const missingFiles = new Set<string>();
    for (const asset of original.assets.filter((asset) => asset.state === 'complete')) {
      const entry = await this.repo.assetPath(asset.id);
      if (!(await this.files.inspect(entry.relativePath, asset.bytes))) missingFiles.add(asset.id);
    }
    if (missingFiles.size) {
      const checked = await this.repo.mutate(original.id, job.generation, (record) => ({
        ...record,
        assets: record.assets.map((asset) =>
          missingFiles.has(asset.id) ? { ...asset, state: 'missing_on_disk' as const } : asset,
        ),
      }));
      if (!checked) throw new AppError('cancelled', 'This download was superseded.', 409);
      original = checked;
    }
    const primary = original.media.filter((media) => media.required);
    if (
      primary.length &&
      primary.every((media) =>
        original.assets.some(
          (asset) =>
            asset.itemId === media.itemId &&
            asset.variantId === media.variantId &&
            asset.state === 'complete' &&
            (!job.requireNoWatermark || asset.watermarkStatus === 'clean'),
        ),
      )
    ) {
      const updated = await this.repo.mutate(original.id, job.generation, (record) => ({
        ...record,
        downloadState: 'complete',
        error: null,
      }));
      if (!updated) throw new AppError('cancelled', 'This download was superseded.', 409);
      return;
    }
    signal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
    const refreshed = await this.resolver.resolve(
      original.sourceUrls.at(-1) ?? original.originalUrl,
      signal,
    );
    if (refreshed.accessError)
      throw new AppError(
        refreshed.accessError.code,
        refreshed.accessError.message,
        422,
        refreshed.accessError.retryable,
      );
    if (refreshed.platform !== original.platform || refreshed.postId !== original.postId)
      throw new AppError('source_changed', 'The share link now identifies another post.', 409);
    if (!original.media.some((media) => media.required))
      original = await this.repo.pinMedia(job, refreshed);
    const missing = original.media.filter(
      (media) =>
        !original.assets.some(
          (asset) =>
            asset.itemId === media.itemId &&
            asset.variantId === media.variantId &&
            asset.state === 'complete' &&
            (!job.requireNoWatermark || asset.watermarkStatus === 'clean'),
        ),
    );
    job.totalItems = missing.filter((media) => media.required).length;
    await this.repo.updateJob(job);
    let primaryError: SafeError | null = null;
    for (const media of missing) {
      if (signal.aborted) throw new AppError('cancelled', 'The download was cancelled.', 409);
      try {
        if (media.required && job.requireNoWatermark && media.watermarkStatus !== 'clean')
          throw new AppError(
            'clean_source_unavailable',
            'No source identified as watermark-free is available.',
            409,
          );
        if (!media.sourceKey)
          throw new AppError(
            'source_identity_unconfirmed',
            'The media identity cannot be confirmed.',
            409,
          );
        const source = refreshed.sources.find(
          (candidate) =>
            candidate.media.itemId === media.itemId &&
            candidate.media.variantId === media.variantId &&
            candidate.media.sourceKey === media.sourceKey,
        );
        if (!source)
          throw new AppError(
            'source_changed',
            'The original media variant is no longer available.',
            409,
          );
        if (!source.urls.length && !source.plan)
          throw new AppError(
            'unsupported_format',
            'No supported downloadable source is exposed for this media.',
            422,
          );
        let bytes = 0;
        let progressWrite: Promise<void> = Promise.resolve();
        let nextProgressAt = 0;
        const retained = await (async () => {
          try {
            return await this.files.retain(job, original, source, signal, (count) => {
              bytes = count;
              if (Date.now() < nextProgressAt) return;
              nextProgressAt = Date.now() + 1000;
              const snapshot = {
                ...job,
                bytes: job.bytes + bytes,
                updatedAt: new Date().toISOString(),
              };
              progressWrite = progressWrite
                .then(async () => {
                  await this.repo.updateJob(snapshot);
                  this.changed(job.recordId, job.id);
                })
                .catch((error) => {
                  this.lastFailure = safeError(error);
                });
            });
          } finally {
            await progressWrite;
          }
        })();
        const adopted = await this.repo.finalize(
          job,
          retained.asset,
          retained.relativePath,
          retained.adopt,
        );
        if (!adopted) {
          await retained.discard();
          throw new AppError('cancelled', 'The record was changed while downloading.', 409);
        }
        job.bytes += bytes;
        if (media.required) job.completedItems += 1;
        await this.repo.updateJob({ ...job, updatedAt: new Date().toISOString() });
        this.changed(job.recordId, job.id);
      } catch (error) {
        if (signal.aborted) throw error;
        if (media.required) primaryError = safeError(error);
      }
    }
    const updated = await this.repo.mutate(original.id, job.generation, (record) => {
      const primary = record.media.filter((media) => media.required);
      const complete = primary.filter((media) =>
        record.assets.some(
          (asset) =>
            asset.itemId === media.itemId &&
            asset.variantId === media.variantId &&
            asset.state === 'complete' &&
            (!job.requireNoWatermark || asset.watermarkStatus === 'clean'),
        ),
      ).length;
      return {
        ...record,
        error: primaryError,
        downloadState:
          complete === primary.length && primary.length > 0
            ? 'complete'
            : complete > 0
              ? 'partial'
              : 'failed',
      };
    });
    if (!updated) throw new AppError('cancelled', 'The record was changed.', 409);
    if (primaryError)
      throw new AppError(primaryError.code, primaryError.message, 409, primaryError.retryable);
  }
}
