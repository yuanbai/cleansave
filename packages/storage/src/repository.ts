import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  assetSchema,
  countCaptureSchema,
  storageUsageSchema,
  type Accepted,
  type Asset,
  type CountCapture,
  type HistoryQuery,
  type ListQuery,
  type StorageUsage,
} from '@cleansave/contracts';
import {
  AppError,
  hash,
  normalizeTags,
  storedJobSchema,
  storedRecordSchema,
  type Capture,
  type LibraryRepository,
  type StoredJob,
  type StoredRecord,
} from '@cleansave/core';

interface RecordsRow {
  id: string;
  platform: string;
  post_id: string | null;
  lifecycle: string;
  saved_at: string;
  fingerprint: string;
  data: string;
  search_text: string;
}

interface JobsRow {
  id: string;
  record_id: string;
  type: string;
  state: string;
  created_at: string;
  data: string;
}

interface CountsRow {
  id: string;
  record_id: string;
  captured_at: string;
  operation_id: string;
  data: string;
}

interface AssetsRow {
  id: string;
  record_id: string;
  path: string;
  data: string;
}

interface IntentsRow {
  id: string;
  record_id: string;
  generation: number;
  job_id: string;
  path: string;
  data: string;
}

interface KeysRow {
  key: string;
  fingerprint: string;
  response: string;
}

interface Schema {
  records: RecordsRow;
  jobs: JobsRow;
  count_captures: CountsRow;
  assets: AssetsRow;
  finalization_intents: IntentsRow;
  request_keys: KeysRow;
  asset_inputs: { asset_id: string; role: string; data: string };
}

type Connection = Kysely<Schema> | Transaction<Schema>;
const cursorSchema = z.object({ at: z.string(), id: z.string(), signature: z.string() });
const now = (): string => new Date().toISOString();
const signatureOf = (value: object): string =>
  hash(
    JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
    ),
  );
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function cursor(value: string | undefined, signature: string): z.infer<typeof cursorSchema> | null {
  if (!value) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
    if (parsed.signature !== signature) throw new Error();
    return parsed;
  } catch {
    throw new AppError('invalid_cursor', 'Use the cursor returned by the matching query.');
  }
}

function parseRecord(row: RecordsRow): StoredRecord {
  return storedRecordSchema.parse(JSON.parse(row.data));
}

function parseJob(row: JobsRow): StoredJob {
  return storedJobSchema.parse(JSON.parse(row.data));
}

/** Own a local SQLite library, transactional jobs, immutable count history, and crash recovery. */
export class SqliteRepository implements LibraryRepository {
  private readonly db: Kysely<Schema>;

  private constructor(
    private readonly root: string,
    database: Database.Database,
  ) {
    this.db = new Kysely<Schema>({ dialect: new SqliteDialect({ database }) });
  }

  /**
   * Acquire exclusive library ownership, migrate supported schema versions, and recover interrupted
   * work.
   */
  public static async open(root: string): Promise<SqliteRepository> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = join(root, 'owner.lock');
    try {
      const file = await open(lock, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    } catch {
      const pid = Number(await readFile(lock, 'utf8').catch(() => '0'));
      let alive = pid > 0;
      try {
        if (alive) process.kill(pid, 0);
      } catch (error) {
        alive =
          error !== null && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH';
      }
      if (alive)
        throw new AppError('library_in_use', 'Another backend owns this data directory.', 409);
      await rm(lock, { force: true });
      const file = await open(lock, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    }
    let native: Database.Database | undefined;
    try {
      const database = new Database(join(root, 'library.sqlite'));
      native = database;
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      const version = z.number().parse(database.pragma('user_version', { simple: true }));
      if (version > 2) {
        database.close();
        throw new AppError(
          'unsupported_database_version',
          'This library was created by a newer CleanSave version.',
          409,
        );
      }
      if (version === 0)
        database.transaction(() => {
          database.exec(`
          CREATE TABLE records (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            post_id TEXT,
            lifecycle TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            data TEXT NOT NULL,
            search_text TEXT NOT NULL
          );
          CREATE UNIQUE INDEX records_post ON records(platform,post_id) WHERE lifecycle='active' AND post_id IS NOT NULL;
          CREATE INDEX records_saved ON records(saved_at,id);
          CREATE INDEX records_input ON records(fingerprint,lifecycle);
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            record_id TEXT NOT NULL,
            type TEXT NOT NULL,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            data TEXT NOT NULL
          );
          CREATE INDEX jobs_queue ON jobs(state,created_at);
          CREATE TABLE count_captures (
            id TEXT PRIMARY KEY,
            record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
            captured_at TEXT NOT NULL,
            operation_id TEXT NOT NULL UNIQUE,
            data TEXT NOT NULL
          );
          CREATE INDEX counts_time ON count_captures(record_id,captured_at,id);
          CREATE TABLE assets (
            id TEXT PRIMARY KEY,
            record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE finalization_intents (
            id TEXT PRIMARY KEY,
            record_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            job_id TEXT NOT NULL,
            path TEXT NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE request_keys (
            key TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            response TEXT NOT NULL
          );
          CREATE VIRTUAL TABLE record_search USING fts5(record_id UNINDEXED, content, tokenize='trigram');
          PRAGMA user_version = 1;
        `);
        })();
      if (version < 2)
        database.transaction(() => {
          database.exec(`
          CREATE TABLE asset_inputs (
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY(asset_id, role)
          );
          PRAGMA user_version = 2;
        `);
        })();
      const repo = new SqliteRepository(root, database);
      await repo.recover();
      return repo;
    } catch (error) {
      if (native?.open) native.close();
      await rm(lock, { force: true });
      throw error;
    }
  }

  private async read(id: string, db: Connection = this.db): Promise<StoredRecord> {
    const row = await db.selectFrom('records').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('record_not_found', 'This record no longer exists.', 404);
    return parseRecord(row);
  }

  private async write(record: StoredRecord, db: Connection = this.db): Promise<void> {
    const search = [
      record.metadata?.title,
      record.metadata?.description,
      record.metadata?.author.name,
      record.note,
      ...record.tags,
    ]
      .filter(Boolean)
      .join(' ')
      .normalize('NFKC')
      .toLowerCase();
    await db
      .insertInto('records')
      .values({
        id: record.id,
        platform: record.platform,
        post_id: record.postId,
        lifecycle: record.lifecycle,
        saved_at: record.savedAt,
        fingerprint: record.fingerprint,
        data: JSON.stringify(record),
        search_text: search,
      })
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({
          post_id: record.postId,
          lifecycle: record.lifecycle,
          data: JSON.stringify(record),
          search_text: search,
        }),
      )
      .execute();
    await sql`DELETE FROM record_search WHERE record_id = ${record.id}`.execute(db);
    if (record.lifecycle === 'active')
      await sql`INSERT INTO record_search(record_id,content) VALUES(${record.id},${search})`.execute(
        db,
      );
  }

  private async writeJob(job: StoredJob, db: Connection = this.db): Promise<void> {
    await db
      .insertInto('jobs')
      .values({
        id: job.id,
        record_id: job.recordId,
        type: job.type,
        state: job.state,
        created_at: job.createdAt,
        data: JSON.stringify(job),
      })
      .onConflict((conflict) =>
        conflict
          .column('id')
          .doUpdateSet({ record_id: job.recordId, state: job.state, data: JSON.stringify(job) }),
      )
      .execute();
  }

  private async writeInputs(asset: Asset, tx: Transaction<Schema>): Promise<void> {
    for (const receipt of asset.inputReceipts)
      await tx
        .insertInto('asset_inputs')
        .values({
          asset_id: asset.id,
          role: receipt.role,
          data: JSON.stringify(receipt),
        })
        .onConflict((conflict) => conflict.columns(['asset_id', 'role']).doNothing())
        .execute();
  }

  private newJob(
    record: StoredRecord,
    type: StoredJob['type'],
    policy = record.options.requireNoWatermark,
  ): StoredJob {
    const at = now();
    return {
      id: randomUUID(),
      recordId: record.id,
      type,
      state: 'queued',
      generation: record.generation,
      metadataRevision: record.metadataRevision,
      requireNoWatermark: policy,
      createdAt: at,
      updatedAt: at,
      bytes: 0,
      completedItems: 0,
      totalItems: 0,
      error: null,
      leaseUntil: null,
    };
  }

  private async checkQueueCapacity(tx: Transaction<Schema>): Promise<void> {
    const queued = await tx
      .selectFrom('jobs')
      .select('id')
      .where('state', '=', 'queued')
      .limit(200)
      .execute();
    if (queued.length >= 200)
      throw new AppError(
        'queue_full',
        'The local job queue is full. Wait for an active job to finish.',
        429,
        true,
      );
  }

  /**
   * Save or reuse a record with explicit media intent; replay matching idempotency keys and reject
   * conflicting reuse.
   */
  public async create(
    input: {
      input: string;
      url: string;
      platform: StoredRecord['platform'];
      downloadContent: boolean;
      requireNoWatermark: boolean;
    },
    key: string | null,
  ): Promise<Accepted> {
    const signature = hash(JSON.stringify(input));
    return this.db.transaction().execute(async (tx) => {
      if (key) {
        const previous = await tx
          .selectFrom('request_keys')
          .selectAll()
          .where('key', '=', key)
          .executeTakeFirst();
        if (previous) {
          if (previous.fingerprint !== signature)
            throw new AppError(
              'idempotency_conflict',
              'This request key was used with different options.',
              409,
            );
          return z
            .object({ recordId: z.string(), jobId: z.string().nullable(), reused: z.boolean() })
            .parse(JSON.parse(previous.response));
        }
      }
      const duplicate = await tx
        .selectFrom('records')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb('fingerprint', '=', hash(input.url)),
            sql<boolean>`EXISTS (SELECT 1 FROM json_each(records.data, '$.sourceUrls') WHERE value = ${input.url})`,
          ]),
        )
        .where('lifecycle', '=', 'active')
        .executeTakeFirst();
      let response: Accepted;
      if (duplicate) {
        let record = parseRecord(duplicate);
        const activeJobs = await tx
          .selectFrom('jobs')
          .selectAll()
          .where('record_id', '=', record.id)
          .where('state', 'in', ['queued', 'running'])
          .execute();
        const active = activeJobs.find((job) => job.type === 'download') ?? activeJobs[0];
        let jobId = active?.id ?? null;
        if (input.downloadContent && active) {
          const current = parseJob(active);
          if (
            current.type === 'download' &&
            current.requireNoWatermark !== input.requireNoWatermark
          )
            throw new AppError(
              'job_conflict',
              'A download with another source policy is already active.',
              409,
            );
          if (current.type === 'resolve') {
            record = {
              ...record,
              options: { downloadContent: true, requireNoWatermark: input.requireNoWatermark },
              downloadState: 'queued',
            };
            await this.write(record, tx);
          }
        }
        if (input.downloadContent && active?.type === 'remove_downloads')
          throw new AppError(
            'job_conflict',
            'Wait for file removal to finish before downloading.',
            409,
          );
        if (input.downloadContent && record.metadata && active?.type !== 'download') {
          await this.checkQueueCapacity(tx);
          const job = this.newJob(record, 'download', input.requireNoWatermark);
          await this.write((record = { ...record, downloadState: 'queued' }), tx);
          await this.writeJob(job, tx);
          jobId = job.id;
        }
        if (input.downloadContent && !record.metadata && !active) {
          await this.checkQueueCapacity(tx);
          record = {
            ...record,
            options: { downloadContent: true, requireNoWatermark: input.requireNoWatermark },
            resolutionState: 'queued',
            downloadState: 'queued',
            error: null,
          };
          const job = this.newJob(record, 'resolve');
          await this.write(record, tx);
          await this.writeJob(job, tx);
          jobId = job.id;
        }
        response = { recordId: record.id, jobId, reused: true };
      } else {
        await this.checkQueueCapacity(tx);
        const record: StoredRecord = {
          id: randomUUID(),
          originalUrl: input.url,
          originalInput: input.input,
          sourceUrls: [input.url],
          fingerprint: hash(input.url),
          savedAt: now(),
          firstCapturedAt: null,
          platform: input.platform,
          postId: null,
          metadata: null,
          metadataRevision: 0,
          counts: null,
          media: [],
          assets: [],
          note: '',
          tags: [],
          annotationDrafts: [],
          annotationRevision: 0,
          options: {
            downloadContent: input.downloadContent,
            requireNoWatermark: input.requireNoWatermark,
          },
          resolutionState: 'queued',
          downloadState: input.downloadContent ? 'queued' : 'not_requested',
          error: null,
          refreshError: null,
          activeJobIds: [],
          mergedIntoId: null,
          generation: 0,
          lifecycle: 'active',
        };
        const job = this.newJob(record, 'resolve');
        await this.write(record, tx);
        await this.writeJob(job, tx);
        response = { recordId: record.id, jobId: job.id, reused: false };
      }
      if (key)
        await tx
          .insertInto('request_keys')
          .values({ key, fingerprint: signature, response: JSON.stringify(response) })
          .execute();
      return response;
    });
  }

  /** Read a persisted record with its active job IDs; throw record_not_found when absent. */
  public async get(id: string): Promise<StoredRecord> {
    const record = await this.read(id);
    const active = await this.db
      .selectFrom('jobs')
      .select('id')
      .where('record_id', '=', id)
      .where('state', 'in', ['queued', 'running'])
      .execute();
    return { ...record, activeJobIds: active.map((job) => job.id) };
  }

  /**
   * Sum completed receipts across the entire active library without loading media or downloading
   * anything. Excludes staging, metadata, missing receipts, and deleting/merged records.
   */
  public async storageUsage(): Promise<StorageUsage> {
    const result = await sql<StorageUsage>`
      SELECT COALESCE(SUM(json_extract(asset.value, '$.bytes')), 0) AS "downloadBytes",
             COUNT(*) AS "downloadedFiles"
      FROM records, json_each(records.data, '$.assets') AS asset
      WHERE records.lifecycle = 'active' AND json_extract(asset.value, '$.state') = 'complete'
    `.execute(this.db);
    return storageUsageSchema.parse(result.rows[0]);
  }

  /** Browse active records with bound filters, full-text search, and stable query-bound cursors. */
  public async list(
    query: ListQuery,
  ): Promise<{ items: StoredRecord[]; nextCursor: string | null }> {
    const signature = signatureOf({ ...query, cursor: null, limit: null });
    const next = cursor(query.cursor, signature);
    let statement = this.db.selectFrom('records').selectAll().where('lifecycle', '=', 'active');
    if (query.platform) statement = statement.where('platform', '=', query.platform);
    const search = query.query.normalize('NFKC').toLowerCase().trim();
    if (search.length >= 3)
      statement = statement.where(
        'id',
        'in',
        sql<string>`(SELECT record_id FROM record_search WHERE record_search MATCH ${'"' + search.replaceAll('"', '""') + '"'})`,
      );
    else if (search)
      statement = statement.where(
        sql<boolean>`search_text LIKE ${'%' + search.replace(/[\\%_]/g, (value) => '\\' + value) + '%'} ESCAPE '\\'`,
      );
    if (next)
      statement = statement.where((eb) =>
        eb.or([
          eb('saved_at', query.order === 'asc' ? '>' : '<', next.at),
          eb.and([
            eb('saved_at', '=', next.at),
            eb('id', query.order === 'asc' ? '>' : '<', next.id),
          ]),
        ]),
      );
    if (query.kind)
      statement = statement.where(
        sql<boolean>`EXISTS (SELECT 1 FROM json_each(records.data, '$.media') WHERE json_extract(value, '$.required') = 1 AND json_extract(value, '$.kind') = ${query.kind})`,
      );
    if (query.state)
      statement = statement.where(
        sql<boolean>`json_extract(records.data, '$.downloadState') = ${query.state}`,
      );
    if (query.tag)
      statement = statement.where(
        sql<boolean>`EXISTS (SELECT 1 FROM json_each(records.data, '$.tags') WHERE value = ${query.tag})`,
      );
    const rows = await statement
      .orderBy('saved_at', query.order)
      .orderBy('id', query.order)
      .limit(query.limit + 1)
      .execute();
    const selected = rows.slice(0, query.limit).map(parseRecord);
    const last = selected.at(-1);
    return {
      items: await Promise.all(selected.map((record) => this.get(record.id))),
      nextCursor:
        rows.length > query.limit && last
          ? encode({ at: last.savedAt, id: last.id, signature })
          : null,
    };
  }

  /** Page immutable count observations within an inclusive-from, exclusive-to time window. */
  public async history(
    id: string,
    query: HistoryQuery,
  ): Promise<{ items: CountCapture[]; nextCursor: string | null }> {
    await this.read(id);
    if (query.from && query.to && new Date(query.from) >= new Date(query.to))
      throw new AppError('invalid_window', 'The start time must precede the end time.');
    const signature = signatureOf({ id, ...query, cursor: null, limit: null });
    const next = cursor(query.cursor, signature);
    let statement = this.db.selectFrom('count_captures').selectAll().where('record_id', '=', id);
    if (query.from)
      statement = statement.where('captured_at', '>=', new Date(query.from).toISOString());
    if (query.to) statement = statement.where('captured_at', '<', new Date(query.to).toISOString());
    if (next)
      statement = statement.where((eb) =>
        eb.or([
          eb('captured_at', query.order === 'asc' ? '>' : '<', next.at),
          eb.and([
            eb('captured_at', '=', next.at),
            eb('id', query.order === 'asc' ? '>' : '<', next.id),
          ]),
        ]),
      );
    const rows = await statement
      .orderBy('captured_at', query.order)
      .orderBy('id', query.order)
      .limit(query.limit + 1)
      .execute();
    const items = rows
      .slice(0, query.limit)
      .map((row) => countCaptureSchema.parse(JSON.parse(row.data)));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encode({ at: last.capturedAt, id: last.id, signature })
          : null,
    };
  }

  /** Apply personal edits only if the expected annotation revision still matches. */
  public async annotate(
    id: string,
    input: { note?: string; tags?: string[]; expectedRevision: number },
  ): Promise<StoredRecord> {
    return this.db.transaction().execute(async (tx) => {
      const record = await this.read(id, tx);
      if (record.lifecycle !== 'active' || record.annotationRevision !== input.expectedRevision)
        throw new AppError(
          'annotation_conflict',
          'The note or tags changed. Keep your draft and reload the current revision.',
          409,
        );
      const updated = {
        ...record,
        note: input.note ?? record.note,
        tags: input.tags ? normalizeTags(input.tags) : record.tags,
        annotationRevision: record.annotationRevision + 1,
      };
      await this.write(updated, tx);
      return updated;
    });
  }

  /**
   * Queue durable operation intent, coalesce active equivalents, and reject conflicting policy or
   * idempotency keys.
   */
  public async enqueue(
    id: string,
    type: StoredJob['type'],
    policy?: boolean,
    key?: string,
  ): Promise<StoredJob> {
    return this.db.transaction().execute(async (tx) => {
      const signature = hash(JSON.stringify({ id, type, policy }));
      if (key) {
        const prior = await tx
          .selectFrom('request_keys')
          .selectAll()
          .where('key', '=', key)
          .executeTakeFirst();
        if (prior) {
          if (prior.fingerprint !== signature)
            throw new AppError(
              'idempotency_conflict',
              'This key was used for another operation.',
              409,
            );
          const stored = storedJobSchema.parse(JSON.parse(prior.response));
          return stored;
        }
      }
      if (type === 'delete') {
        const prior = await tx
          .selectFrom('jobs')
          .selectAll()
          .where('record_id', '=', id)
          .where('type', '=', 'delete')
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (prior && ['queued', 'running', 'succeeded'].includes(prior.state))
          return parseJob(prior);
      }
      let record = await this.read(id, tx);
      if (record.lifecycle !== 'active' && type !== 'delete')
        throw new AppError('record_not_found', 'This record is being removed.', 404);
      if (type === 'refresh' && !record.metadata)
        throw new AppError(
          'metadata_not_available',
          'Resolve this record before refreshing its metadata.',
          409,
        );
      const existing = await tx
        .selectFrom('jobs')
        .selectAll()
        .where('record_id', '=', id)
        .where('type', '=', type)
        .where('state', 'in', ['queued', 'running'])
        .executeTakeFirst();
      if (existing) {
        const job = parseJob(existing);
        if (policy !== undefined && job.requireNoWatermark !== policy)
          throw new AppError(
            'job_conflict',
            'A download with another source policy is already active.',
            409,
          );
        if (key)
          await tx
            .insertInto('request_keys')
            .values({ key, fingerprint: signature, response: JSON.stringify(job) })
            .execute();
        return job;
      }
      if (type === 'delete' || type === 'remove_downloads') {
        record = {
          ...record,
          generation: record.generation + 1,
          lifecycle: type === 'delete' ? 'deleting' : 'active',
          downloadState: 'not_requested',
          assets: [],
          options: { ...record.options, downloadContent: false },
        };
        const active = await tx
          .selectFrom('jobs')
          .selectAll()
          .where('record_id', '=', id)
          .where('state', 'in', ['queued', 'running'])
          .execute();
        for (const row of active)
          await this.writeJob({ ...parseJob(row), state: 'cancelled', updatedAt: now() }, tx);
      }
      if (type === 'download') record = { ...record, downloadState: 'queued', error: null };
      if (type === 'resolve') record = { ...record, resolutionState: 'queued', error: null };
      if (type === 'refresh') record = { ...record, refreshError: null };
      if (type !== 'delete' && type !== 'remove_downloads') await this.checkQueueCapacity(tx);
      await this.write(record, tx);
      const job = this.newJob(record, type, policy);
      await this.writeJob(job, tx);
      if (key)
        await tx
          .insertInto('request_keys')
          .values({ key, fingerprint: signature, response: JSON.stringify(job) })
          .execute();
      return job;
    });
  }

  /**
   * Transactionally claim the oldest runnable job, allowing independent metadata refresh and
   * download work.
   */
  public async claim(): Promise<StoredJob | null> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('jobs')
        .selectAll()
        .where('state', '=', 'queued')
        .where(
          sql<boolean>`NOT EXISTS (SELECT 1 FROM jobs running WHERE running.record_id = jobs.record_id AND running.state = 'running' AND NOT ((jobs.type = 'refresh' AND running.type = 'download') OR (jobs.type = 'download' AND running.type = 'refresh')))`,
        )
        .orderBy('created_at')
        .executeTakeFirst();
      if (!row) return null;
      const job = {
        ...parseJob(row),
        state: 'running' as const,
        updatedAt: now(),
        leaseUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      await this.writeJob(job, tx);
      const record = await this.read(job.recordId, tx);
      if (record.lifecycle === 'active' && record.generation === job.generation)
        await this.write(
          {
            ...record,
            ...(job.type === 'resolve'
              ? { resolutionState: 'resolving' as const }
              : job.type === 'download'
                ? { downloadState: 'downloading' as const }
                : {}),
          },
          tx,
        );
      return job;
    });
  }

  /** Read durable operation intent, progress, and terminal error state. */
  public async getJob(id: string): Promise<StoredJob> {
    const row = await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('job_not_found', 'This job does not exist.', 404);
    return parseJob(row);
  }

  /** Return up to 100 recent jobs in reverse creation order. */
  public async jobs(): Promise<StoredJob[]> {
    return (
      await this.db
        .selectFrom('jobs')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute()
    ).map(parseJob);
  }

  /** Persist a job update unless cancellation has already made it terminal. */
  public async updateJob(job: StoredJob): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', job.id)
        .executeTakeFirst();
      if (row && row.state !== 'cancelled') await this.writeJob(job, tx);
    });
  }

  /** Apply a record mutation only while its active lifecycle and generation still match. */
  public async mutate(
    id: string,
    generation: number,
    fn: (record: StoredRecord) => StoredRecord,
  ): Promise<StoredRecord | null> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('records')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      const record = parseRecord(row);
      if (record.lifecycle !== 'active' || record.generation !== generation) return null;
      const updated = fn(record);
      await this.write(updated, tx);
      return updated;
    });
  }

  /**
   * Atomically replace source metadata and append one count observation, or merge a duplicate post
   * without a new observation.
   */
  public async capture(job: StoredJob, capture: Capture): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      let record = await this.read(job.recordId, tx);
      const operation = await tx
        .selectFrom('jobs')
        .select('state')
        .where('id', '=', job.id)
        .executeTakeFirst();
      if (operation?.state !== 'running')
        throw new AppError('cancelled', 'This capture is no longer active.', 409);
      // Refresh is fenced by operation state and metadata revision. Cancelling an
      // independent download advances file generation without invalidating counts.
      if (
        record.lifecycle !== 'active' ||
        (job.type !== 'refresh' && record.generation !== job.generation)
      )
        throw new AppError('cancelled', 'The capture was superseded.', 409);
      if (
        record.postId &&
        (record.platform !== capture.platform || record.postId !== capture.postId)
      )
        throw new AppError('source_changed', 'This response belongs to another post.', 409);
      const duplicate = await tx
        .selectFrom('records')
        .selectAll()
        .where('platform', '=', capture.platform)
        .where('post_id', '=', capture.postId)
        .where('lifecycle', '=', 'active')
        .where('id', '!=', record.id)
        .executeTakeFirst();
      if (duplicate) {
        const target = parseRecord(duplicate);
        const drafts =
          record.note || record.tags.length
            ? [...target.annotationDrafts, { note: record.note, tags: record.tags }]
            : target.annotationDrafts;
        await this.write(
          {
            ...target,
            sourceUrls: [...new Set([...target.sourceUrls, record.originalUrl])],
            annotationDrafts: drafts,
          },
          tx,
        );
        await this.write({ ...record, lifecycle: 'merged', mergedIntoId: target.id }, tx);
        await this.writeJob({ ...job, recordId: target.id }, tx);
        return target.id;
      }
      if (job.type === 'resolve' && record.metadata) return record.id;
      if (job.type === 'refresh' && record.metadataRevision !== job.metadataRevision)
        throw new AppError('capture_superseded', 'A newer capture already exists.', 409);
      const count: CountCapture = {
        id: randomUUID(),
        recordId: record.id,
        capturedAt: capture.metadata.capturedAt,
        adapterVersion: capture.metadata.adapterVersion,
        counts: capture.counts,
      };
      const existing = await tx
        .selectFrom('count_captures')
        .selectAll()
        .where('operation_id', '=', job.id)
        .executeTakeFirst();
      if (existing) return record.id;
      const chosen = new Map<string, Capture['sources'][number]>();
      for (const source of capture.sources) {
        const previous = chosen.get(source.media.itemId);
        if (
          !previous ||
          (source.media.watermarkStatus === 'clean' && previous.media.watermarkStatus !== 'clean')
        )
          chosen.set(source.media.itemId, source);
      }
      const manifest = [...chosen.values()]
        .map((source) => source.media)
        .sort((a, b) => a.position - b.position);
      const changed =
        record.metadata &&
        capture.sources.length > 0 &&
        hash(JSON.stringify(record.media)) !== hash(JSON.stringify(manifest));
      record = {
        ...record,
        postId: capture.postId,
        metadata: {
          ...capture.metadata,
          warnings: changed
            ? [...capture.metadata.warnings, 'source_media_changed']
            : capture.metadata.warnings,
        },
        metadataRevision: record.metadataRevision + 1,
        firstCapturedAt: record.firstCapturedAt ?? capture.metadata.capturedAt,
        counts: count,
        media: record.metadata ? record.media : manifest,
        resolutionState: 'resolved',
        refreshError: null,
        error: job.type === 'resolve' ? null : record.error,
      };
      await tx
        .insertInto('count_captures')
        .values({
          id: count.id,
          record_id: record.id,
          captured_at: count.capturedAt,
          operation_id: job.id,
          data: JSON.stringify(count),
        })
        .execute();
      await this.write(record, tx);
      return record.id;
    });
  }

  /** Pin the first verified primary manifest when an earlier metadata-only capture had none. */
  public async pinMedia(job: StoredJob, capture: Capture): Promise<StoredRecord> {
    return this.db.transaction().execute(async (tx) => {
      const record = await this.read(job.recordId, tx);
      const operation = await tx
        .selectFrom('jobs')
        .select('state')
        .where('id', '=', job.id)
        .executeTakeFirst();
      if (
        record.lifecycle !== 'active' ||
        record.generation !== job.generation ||
        operation?.state !== 'running'
      )
        throw new AppError('cancelled', 'This download was superseded.', 409);
      if (record.platform !== capture.platform || record.postId !== capture.postId)
        throw new AppError('source_changed', 'The media belongs to another post.', 409);
      if (record.media.some((media) => media.required)) return record;
      const items = new Map<string, Capture['sources'][number]>();
      for (const source of capture.sources)
        if (!items.has(source.media.itemId)) items.set(source.media.itemId, source);
      const media = [...items.values()]
        .map((source) => source.media)
        .sort((a, b) => a.position - b.position);
      if (!media.some((item) => item.required))
        throw new AppError(
          'unsupported_format',
          'No verified primary media manifest is available.',
          422,
        );
      const updated = { ...record, media };
      await this.write(updated, tx);
      return updated;
    });
  }

  /**
   * Cancel active resolution, download, or refresh while preserving completed files and historical
   * counts.
   */
  public async cancel(id: string): Promise<StoredJob> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw new AppError('job_not_found', 'This job does not exist.', 404);
      const job = parseJob(row);
      if (!['queued', 'running'].includes(job.state)) return job;
      if (job.type === 'delete' || job.type === 'remove_downloads')
        throw new AppError(
          'job_not_cancellable',
          'File removal cannot be cancelled after it has been requested.',
          409,
        );
      const cancelled = { ...job, state: 'cancelled' as const, updatedAt: now() };
      await this.writeJob(cancelled, tx);
      const record = await this.read(job.recordId, tx);
      if (job.type !== 'refresh')
        await this.write(
          {
            ...record,
            generation: record.generation + 1,
            downloadState: job.type === 'download' ? 'cancelled' : record.downloadState,
            ...(job.type === 'resolve'
              ? {
                  resolutionState: 'failed' as const,
                  downloadState: record.options.downloadContent
                    ? ('cancelled' as const)
                    : record.downloadState,
                  error: new AppError('cancelled', 'Resolution was cancelled.', 409).safe(),
                }
              : {}),
          },
          tx,
        );
      return cancelled;
    });
  }

  /**
   * Journal file adoption, invoke the rename outside SQLite, then commit the receipt if the
   * generation remains current.
   */
  public async finalize(
    job: StoredJob,
    asset: Asset,
    relativePath: string,
    adopt: () => Promise<void>,
  ): Promise<boolean> {
    const valid = await this.db.transaction().execute(async (tx) => {
      const record = await this.read(job.recordId, tx);
      const row = await tx
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', job.id)
        .executeTakeFirst();
      if (
        record.lifecycle !== 'active' ||
        record.generation !== job.generation ||
        row?.state !== 'running'
      )
        return false;
      await tx
        .insertInto('finalization_intents')
        .values({
          id: asset.id,
          record_id: record.id,
          generation: job.generation,
          job_id: job.id,
          path: relativePath,
          data: JSON.stringify(asset),
        })
        .execute();
      return true;
    });
    if (!valid) return false;
    await adopt();
    return this.db.transaction().execute(async (tx) => {
      const record = await this.read(job.recordId, tx);
      const row = await tx
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', job.id)
        .executeTakeFirst();
      if (
        record.lifecycle !== 'active' ||
        record.generation !== job.generation ||
        row?.state !== 'running'
      )
        return false;
      await tx
        .insertInto('assets')
        .values({
          id: asset.id,
          record_id: record.id,
          path: relativePath,
          data: JSON.stringify(asset),
        })
        .execute();
      await this.write({ ...record, assets: [...record.assets, asset] }, tx);
      await this.writeInputs(asset, tx);
      await tx.deleteFrom('finalization_intents').where('id', '=', asset.id).execute();
      return true;
    });
  }

  /** Read a complete owned asset and its relative path; reject missing or deleting records. */
  public async assetPath(id: string): Promise<{ asset: Asset; relativePath: string }> {
    const row = await this.db
      .selectFrom('assets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('asset_not_found', 'This file has not been downloaded.', 404);
    const record = await this.read(row.record_id);
    if (record.lifecycle !== 'active')
      throw new AppError('asset_not_found', 'This record is being deleted.', 404);
    const asset = record.assets.find((value) => value.id === id);
    if (!asset || asset.state !== 'complete')
      throw new AppError('asset_not_found', 'This file is missing.', 404);
    return { asset, relativePath: row.path };
  }

  /** Commit removal of retained-file receipts while keeping the record and count observations. */
  public async removeAssets(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const record = await this.read(id, tx);
      await tx.deleteFrom('assets').where('record_id', '=', id).execute();
      await tx.deleteFrom('finalization_intents').where('record_id', '=', id).execute();
      await this.write({ ...record, assets: [], downloadState: 'not_requested', error: null }, tx);
    });
  }

  /**
   * Delete record metadata and dependent receipts/history after owned-file cleanup; retain terminal
   * job status.
   */
  public async deleteRecord(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`DELETE FROM record_search WHERE record_id = ${id}`.execute(tx);
      await tx.deleteFrom('finalization_intents').where('record_id', '=', id).execute();
      for (const row of await tx
        .selectFrom('jobs')
        .selectAll()
        .where('record_id', '=', id)
        .where('type', '=', 'delete')
        .where('state', 'in', ['queued', 'running'])
        .execute())
        await this.writeJob(
          { ...parseJob(row), state: 'succeeded', updatedAt: now(), leaseUntil: null },
          tx,
        );
      await tx.deleteFrom('records').where('id', '=', id).execute();
    });
  }

  private async recover(): Promise<void> {
    for (const row of await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('state', 'in', ['running', 'interrupted'])
      .execute())
      await this.writeJob({
        ...parseJob(row),
        state: 'queued',
        leaseUntil: null,
        updatedAt: now(),
      });
    for (const intent of await this.db.selectFrom('finalization_intents').selectAll().execute()) {
      if (!/^records\/[\w-]+\/media\/[\w-]+\.[a-z0-9]+$/.test(intent.path))
        throw new AppError(
          'invalid_storage_path',
          'A finalization receipt has an invalid file path.',
          500,
        );
      const row = await this.db
        .selectFrom('records')
        .selectAll()
        .where('id', '=', intent.record_id)
        .executeTakeFirst();
      const file = join(this.root, intent.path);
      const asset = assetSchema.parse(JSON.parse(intent.data));
      let valid = false;
      try {
        const target = await realpath(file),
          base = await realpath(this.root);
        if (!target.startsWith(base + sep))
          throw new AppError('invalid_storage_path', 'A file escapes the data directory.', 500);
        const digest = createHash('sha256');
        let length = 0;
        for await (const chunk of createReadStream(target)) {
          digest.update(chunk);
          length += chunk.length;
        }
        valid = length === asset.bytes && digest.digest('hex') === asset.sha256;
      } catch {
        /* Missing or invalid files will be retried. */
      }
      const record = row ? parseRecord(row) : null;
      if (
        record?.lifecycle === 'active' &&
        record.generation === intent.generation &&
        valid &&
        asset.recordId === record.id
      ) {
        await this.db.transaction().execute(async (tx) => {
          await tx
            .insertInto('assets')
            .values({ id: asset.id, record_id: record.id, path: intent.path, data: intent.data })
            .onConflict((conflict) => conflict.column('id').doNothing())
            .execute();
          if (!record.assets.some((value) => value.id === asset.id))
            await this.write({ ...record, assets: [...record.assets, asset] }, tx);
          await this.writeInputs(asset, tx);
          await tx.deleteFrom('finalization_intents').where('id', '=', intent.id).execute();
        });
      } else {
        await rm(file, { force: true });
        await this.db.deleteFrom('finalization_intents').where('id', '=', intent.id).execute();
      }
    }
    for (const row of await this.db.selectFrom('assets').selectAll().execute()) {
      let missing: boolean;
      try {
        const path = await realpath(join(this.root, row.path)),
          base = await realpath(this.root);
        missing = !path.startsWith(base + sep);
      } catch {
        missing = true;
      }
      if (missing) {
        const record = await this.read(row.record_id);
        const assets = record.assets.map((asset) =>
          asset.id === row.id ? { ...asset, state: 'missing_on_disk' as const } : asset,
        );
        await this.write({
          ...record,
          assets,
          downloadState: assets.some((asset) => asset.required && asset.state === 'complete')
            ? 'partial'
            : 'failed',
        });
      }
    }
    await rm(join(this.root, 'staging'), { recursive: true, force: true });
  }

  /** Release resources owned by this instance; callers must not reuse it afterward. */
  public async close(): Promise<void> {
    await this.db.destroy();
    await rm(join(this.root, 'owner.lock'), { force: true });
  }
}
