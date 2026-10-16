import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  acceptedSchema,
  annotationSchema,
  candidatesSchema,
  countPageSchema,
  createSchema,
  downloadSchema,
  historySchema,
  inputSchema,
  jobSchema,
  listSchema,
  recordPageSchema,
  recordSchema,
  recordSummarySchema,
  type Accepted,
  type Platform,
  type RecordDto,
} from '@cleansave/contracts';
import {
  AppError,
  publicRecord,
  safeError,
  Worker,
  type Resolver,
  type AccessSource,
  type HttpResult,
} from '@cleansave/core';
import { mediaDescriptorSchema, settingsSchema, type ToolService } from '@cleansave/client';
import {
  PlatformResolver,
  NetworkSession,
  ConnectionPolicy,
  PublicBrowser,
  platformFor,
  type NetworkOptions,
  capabilities,
  inspectInput,
  selectInput,
  openMedia,
} from '@cleansave/resolvers';
import { SqliteRepository, FileStore } from '@cleansave/storage';
import { createMcpServer } from '@cleansave/mcp';
import { Auth, isLoopbackAddress, type Scope } from './auth.js';

/**
 * Backend paths and loopback configuration; resolver and media transport overrides support isolated
 * tests.
 */
export interface BackendOptions {
  network?: NetworkOptions;
  proxyPlatforms?: Platform[];
  browserExecutable?: string;
  root: string;
  /** Require browser pairing or a valid bearer token; defaults to unrestricted local access. */
  requirePairing?: boolean;
  port?: number;
  dev?: boolean;
  webRoot?: string;
  resolver?: Resolver;
  fetchMedia?: (url: string, source: AccessSource, signal: AbortSignal) => Promise<HttpResult>;
}

/** A running-library owner; close app to stop jobs, close SQLite, and release its lock. */
export interface Backend {
  app: FastifyInstance;
  repo: SqliteRepository;
  worker: Worker;
  auth: Auth;
  service: (scopes: Scope[], requestKey?: string) => ToolService;
  files: FileStore;
}
const params = z.object({ id: z.uuid() });
const empty = z.object({}).strict();
const publicJob = (job: unknown): z.infer<typeof jobSchema> => jobSchema.parse(job);

/**
 * Parse one inclusive HTTP byte range, including suffix ranges; throw a safe 416 error when
 * unsatisfiable.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const a = match?.[1],
    b = match?.[2];
  if (!match || (!a && !b) || size === 0)
    throw new AppError('invalid_range', 'The byte range is not satisfiable.', 416);
  const start = a ? Number(a) : Math.max(0, size - Number(b));
  const end = b && a ? Math.min(Number(b), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!a && Number(b) <= 0)
  )
    throw new AppError('invalid_range', 'The byte range is not satisfiable.', 416);
  return { start, end };
}

/**
 * Create the loopback-only API, worker, storage, and MCP endpoint with opt-in pairing.
 * The caller starts listening and must close app to release library ownership.
 */
export async function createBackend(options: BackendOptions): Promise<Backend> {
  new ConnectionPolicy(options.network);
  const port = options.port ?? 4777;
  const proxyPlatforms = options.proxyPlatforms ?? ['youtube', 'tiktok'];
  const networkFor = (platform: Platform | null | undefined): NetworkOptions =>
    platform && proxyPlatforms.includes(platform) ? (options.network ?? {}) : {};
  const repo = await SqliteRepository.open(options.root);
  const auth = new Auth(options.root, options.requirePairing);
  try {
    await auth.initialize();
  } catch (error) {
    await repo.close();
    throw error;
  }
  const files = new FileStore(
    options.root,
    options.fetchMedia ??
      ((url, source, signal) =>
        openMedia(url, source, signal, networkFor(platformFor(new URL(source.referer).hostname)))),
    async (id) => repo.get(id).catch(() => null),
  );
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    exposeHeadRoutes: true,
    // Jobs drain in preClose; hijacked MCP HTTP connections must also release on shutdown.
    forceCloseConnections: true,
  }).withTypeProvider<ZodTypeProvider>();
  const clients = new Set<{ write: (text: string) => boolean; end: () => void }>();
  let sequence = 0;
  const notify = (recordId: string, jobId: string): void => {
    const event = `id: ${++sequence}\nevent: changed\ndata: ${JSON.stringify({ recordId, jobId })}\n\n`;
    for (const client of clients) client.write(event);
  };
  const browserRecovery = options.browserExecutable
    ? new PublicBrowser(options.browserExecutable, networkFor('douyin'))
    : null;
  const worker = new Worker(
    repo,
    options.resolver ??
      new PlatformResolver(
        (platform) => new NetworkSession(undefined, undefined, undefined, networkFor(platform)),
        browserRecovery
          ? (id, signal, pageUrl) => browserRecovery.douyin(id, signal, pageUrl)
          : undefined,
      ),
    files,
    notify,
  );
  const timer = setInterval(() => worker.kick(), 1000);
  timer.unref();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(swagger, {
    openapi: { info: { title: 'CleanSave API', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...(options.dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
  ]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const scopes = new WeakMap<FastifyRequest, Scope[]>();
  app.addHook('onRequest', async (request) => {
    if (!isLoopbackAddress(request.raw.socket.remoteAddress))
      throw new AppError('local_access_only', 'Only localhost connections are allowed.', 403);
    if (!hosts.has(request.headers.host ?? ''))
      throw new AppError('invalid_host', 'Use the local CleanSave address.', 403);
    const origin = request.headers.origin;
    if (origin && !origins.has(origin))
      throw new AppError('invalid_origin', 'This browser origin is not allowed.', 403);
    const path = request.url.split('?')[0] ?? '';
    if (path === '/health' || (!path.startsWith('/api/') && path !== '/mcp')) return;
    if (path === '/api/v1/session') {
      if (!origin || !origins.has(origin))
        throw new AppError('invalid_origin', 'Pair from the local app.', 403);
      return;
    }
    if (
      auth.requirePairing &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !request.headers.authorization &&
      !origin
    )
      throw new AppError('invalid_origin', 'Browser writes require a local origin.', 403);
    scopes.set(
      request,
      await auth.authorize(request.headers.authorization, request.cookies.cleansave_session),
    );
  });
  app.setErrorHandler((error, request, reply) => {
    const invalid =
      error instanceof z.ZodError ||
      (typeof error === 'object' && error !== null && 'validation' in error);
    const status = error instanceof AppError ? error.status : invalid ? 400 : 500;
    const httpStatus =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : status;
    void reply.code(httpStatus).send({
      error:
        invalid || (httpStatus < 500 && !(error instanceof AppError))
          ? {
              code: httpStatus === 413 ? 'request_too_large' : 'invalid_request',
              message:
                httpStatus === 413
                  ? 'The request exceeds the size limit.'
                  : 'Check the input and try again.',
              retryable: false,
            }
          : safeError(error),
      requestId: request.id,
    });
  });
  const requireScope = (granted: Scope[], scope: Scope): void => {
    if (!granted.includes(scope))
      throw new AppError('scope_required', `This operation requires ${scope} access.`, 403);
  };
  const accepted = async (
    id: string,
    type: Parameters<typeof repo.enqueue>[1],
    policy?: boolean,
    key?: string,
  ): Promise<Accepted> => {
    if (type === 'delete' || type === 'remove_downloads') {
      for (const job of await repo.jobs())
        if (
          job.recordId === id &&
          ['queued', 'running'].includes(job.state) &&
          job.type !== 'delete' &&
          job.type !== 'remove_downloads'
        )
          await worker.cancel(job.id);
    }
    const job = await repo.enqueue(id, type, policy, key);
    worker.kick();
    notify(id, job.id);
    return { recordId: id, jobId: job.id, reused: false };
  };
  const service = (granted: Scope[], requestKey?: string): ToolService => {
    const check = (scope: Scope): void => requireScope(granted, scope);
    const get = async (id: string): Promise<RecordDto> => {
      check('read');
      const record = await repo.get(id);
      if (record.lifecycle === 'deleting')
        throw new AppError('record_not_found', 'This record is being removed.', 404);
      return publicRecord(record);
    };
    return {
      inspect: async (input) => {
        check('read');
        return inspectInput(input);
      },
      create: async (raw, key) => {
        check('write');
        const input = createSchema.parse(raw);
        const selected = selectInput(input.input, input.selectedUrl);
        const result = await repo.create(
          {
            input: input.input,
            url: selected.url,
            platform: selected.platform,
            downloadContent: input.downloadContent,
            requireNoWatermark: input.requireNoWatermark,
          },
          key ?? null,
        );
        worker.kick();
        notify(result.recordId, result.jobId ?? '');
        return result;
      },
      getRecord: get,
      list: async (input) => {
        check('read');
        const page = await repo.list(listSchema.parse(input ?? {}));
        return {
          nextCursor: page.nextCursor,
          items: page.items.map((record) =>
            recordSummarySchema.parse({
              ...publicRecord(record),
              title: record.metadata?.title || record.metadata?.description.slice(0, 200) || '',
              author: record.metadata?.author.name ?? '',
              capturedAt: record.metadata?.capturedAt ?? null,
              kind: record.media.find((media) => media.required)?.kind ?? null,
              itemCount: record.media.filter((media) => media.required).length,
              retainedCount: record.assets.filter(
                (asset) => asset.required && asset.state === 'complete',
              ).length,
              previewAssetId:
                record.assets.find((asset) => asset.kind === 'image' && asset.state === 'complete')
                  ?.id ?? null,
            }),
          ),
        };
      },
      history: async (id, input) => {
        await get(id);
        return repo.history(id, historySchema.parse(input ?? {}));
      },
      annotate: async (id, raw) => {
        check('write');
        const input = annotationSchema.parse(raw);
        const record = await repo.annotate(id, {
          expectedRevision: input.expectedRevision,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
        });
        await files.manifest(publicRecord(record)).catch(() => {});
        notify(id, '');
        return publicRecord(record);
      },
      refresh: async (id) => {
        check('write');
        return accepted(id, 'refresh', undefined, requestKey);
      },
      download: async (id, policy) => {
        check('write');
        return accepted(id, 'download', policy, requestKey);
      },
      getJob: async (id) => {
        check('read');
        return publicJob(await repo.getJob(id));
      },
      cancelJob: async (id) => {
        check('write');
        return publicJob(await worker.cancel(id));
      },
      retryJob: async (id) => {
        check('write');
        const job = await repo.getJob(id);
        if (!['failed', 'interrupted', 'cancelled'].includes(job.state))
          throw new AppError('job_conflict', 'Only unsuccessful jobs can be retried.', 409);
        if (job.type === 'delete' || job.type === 'remove_downloads') check('delete');
        return accepted(job.recordId, job.type, job.requireNoWatermark);
      },
      getMedia: async (id, localPath) => {
        check('read');
        if (localPath) check('local_path');
        const entry = await repo.assetPath(id);
        let path: string;
        try {
          path = await files.ownedPath(entry.relativePath);
        } catch {
          throw new AppError('asset_not_found', 'The saved file is missing from disk.', 404);
        }
        return {
          asset: entry.asset,
          contentUrl: `http://127.0.0.1:${port}/api/v1/assets/${id}/content`,
          ...(localPath ? { localPath: path } : {}),
        };
      },
      preview: async (id) => {
        check('read');
        const entry = await repo.assetPath(id);
        if (!entry.asset.mime.startsWith('image/') || entry.asset.bytes > 2 * 1024 * 1024)
          return null;
        const bytes = await readFile(await files.ownedPath(entry.relativePath));
        return { mime: entry.asset.mime, data: bytes.toString('base64') };
      },
      removeDownloads: async (id) => {
        check('delete');
        return accepted(id, 'remove_downloads');
      },
      deleteRecord: async (id) => {
        check('delete');
        return accepted(id, 'delete');
      },
      capabilities: async () => {
        check('read');
        return {
          adapters: capabilities.map((capability) => ({
            ...capability,
            validation:
              capability.platform === 'youtube'
                ? 'live-direct-and-mux-download; per-post-media-refusals-observed'
                : 'live-download-and-playback',
            lastLiveCheck: '2026-10-15',
          })),
          browserRecovery: Boolean(browserRecovery),
          proxyPlatforms: options.network?.proxy ? proxyPlatforms : [],
          adaptiveYouTube: true,
          youtubeFormats: {
            staticH264AacMux: true,
            sabr: false,
            hls: false,
            dash: false,
            drm: false,
          },
          mediaPreviewLimitBytes: 2 * 1024 * 1024,
        };
      },
    };
  };
  const forRequest = (request: FastifyRequest): ToolService =>
    service(
      scopes.get(request) ?? [],
      z.string().max(128).optional().parse(request.headers['idempotency-key']),
    );
  app.get(
    '/health',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );
  app.post(
    '/api/v1/session',
    {
      schema: {
        body: z.object({ secret: z.string().min(1).max(256) }).strict(),
        response: { 200: z.object({ paired: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      reply.setCookie('cleansave_session', auth.pair(request.body.secret), {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 86400,
      });
      return { paired: true as const };
    },
  );
  app.post(
    '/api/v1/inputs/inspect',
    { schema: { body: inputSchema, response: { 200: candidatesSchema } } },
    (request) => forRequest(request).inspect(request.body.input),
  );
  app.post(
    '/api/v1/records',
    {
      schema: {
        body: createSchema,
        headers: z.object({ 'idempotency-key': z.string().min(1).max(128).optional() }),
        response: { 202: acceptedSchema },
      },
    },
    async (request, reply) => {
      reply.code(202);
      return forRequest(request).create(request.body, request.headers['idempotency-key']);
    },
  );
  app.get(
    '/api/v1/records',
    { schema: { querystring: listSchema, response: { 200: recordPageSchema } } },
    (request) => forRequest(request).list(request.query),
  );
  app.get(
    '/api/v1/records/:id',
    { schema: { params, response: { 200: recordSchema } } },
    (request) => forRequest(request).getRecord(request.params.id),
  );
  app.patch(
    '/api/v1/records/:id',
    { schema: { params, body: annotationSchema, response: { 200: recordSchema } } },
    (request) => {
      const input = request.body;
      return forRequest(request).annotate(request.params.id, {
        expectedRevision: input.expectedRevision,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      });
    },
  );
  app.get(
    '/api/v1/records/:id/counts/history',
    { schema: { params, querystring: historySchema, response: { 200: countPageSchema } } },
    (request) => forRequest(request).history(request.params.id, request.query),
  );
  app.post(
    '/api/v1/records/:id/metadata/refresh',
    { schema: { params, body: empty, response: { 202: acceptedSchema } } },
    async (request, reply) => {
      reply.code(202);
      return forRequest(request).refresh(request.params.id);
    },
  );
  app.post(
    '/api/v1/records/:id/resolve',
    { schema: { params, body: empty, response: { 202: acceptedSchema } } },
    async (request, reply) => {
      requireScope(scopes.get(request) ?? [], 'write');
      reply.code(202);
      return accepted(request.params.id, 'resolve');
    },
  );
  app.post(
    '/api/v1/records/:id/downloads',
    { schema: { params, body: downloadSchema, response: { 202: acceptedSchema } } },
    async (request, reply) => {
      reply.code(202);
      return forRequest(request).download(request.params.id, request.body.requireNoWatermark);
    },
  );
  app.delete(
    '/api/v1/records/:id/downloads',
    { schema: { params, response: { 202: acceptedSchema } } },
    async (request, reply) => {
      reply.code(202);
      return forRequest(request).removeDownloads(request.params.id);
    },
  );
  app.delete(
    '/api/v1/records/:id',
    { schema: { params, response: { 202: acceptedSchema } } },
    async (request, reply) => {
      reply.code(202);
      return forRequest(request).deleteRecord(request.params.id);
    },
  );
  app.get('/api/v1/records/:id/export', { schema: { params } }, async (request) => ({
    version: 1,
    record: await forRequest(request).getRecord(request.params.id),
  }));
  app.get(
    '/api/v1/jobs',
    { schema: { response: { 200: z.array(jobSchema) } } },
    async (request) => {
      requireScope(scopes.get(request) ?? [], 'read');
      return (await repo.jobs()).map(publicJob);
    },
  );
  app.get('/api/v1/jobs/:id', { schema: { params, response: { 200: jobSchema } } }, (request) =>
    forRequest(request).getJob(request.params.id),
  );
  app.post(
    '/api/v1/jobs/:id/cancel',
    { schema: { params, body: empty, response: { 200: jobSchema } } },
    (request) => forRequest(request).cancelJob(request.params.id),
  );
  app.post(
    '/api/v1/jobs/:id/retry',
    { schema: { params, body: empty, response: { 202: acceptedSchema } } },
    async (request, reply) => {
      reply.code(202);
      return forRequest(request).retryJob(request.params.id);
    },
  );
  app.get(
    '/api/v1/assets/:id',
    {
      schema: {
        params,
        querystring: z.object({ localPath: z.enum(['true', 'false']).default('false') }),
        response: { 200: mediaDescriptorSchema },
      },
    },
    (request) =>
      forRequest(request).getMedia(request.params.id, request.query.localPath === 'true'),
  );
  app.get('/api/v1/assets/:id/content', { schema: { params } }, async (request, reply) => {
    requireScope(scopes.get(request) ?? [], 'read');
    const entry = await repo.assetPath(request.params.id);
    let path: string;
    try {
      path = await files.ownedPath(entry.relativePath);
    } catch {
      throw new AppError('asset_not_found', 'The saved file is missing from disk.', 404);
    }
    const info = await stat(path);
    if (info.size !== entry.asset.bytes)
      throw new AppError('invalid_media', 'The saved file has changed on disk.', 409);
    reply
      .header('accept-ranges', 'bytes')
      .header('etag', '"' + entry.asset.sha256 + '"')
      .header('content-type', entry.asset.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-cache')
      .header(
        'content-disposition',
        `inline; filename="${entry.asset.id}.${path.split('.').at(-1)}"`,
      );
    if (
      request.headers['if-none-match'] === '"' + entry.asset.sha256 + '"' &&
      !request.headers.range
    )
      return reply.code(304).send();
    let range: ReturnType<typeof byteRange>;
    try {
      range = byteRange(request.headers.range, info.size);
    } catch (error) {
      reply.header('content-range', `bytes */${info.size}`);
      throw error;
    }
    if (range)
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
        .header('content-length', range.end - range.start + 1);
    else reply.header('content-length', info.size);
    if (request.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(path, range ?? undefined));
  });
  app.get('/api/v1/capabilities', async (request) => forRequest(request).capabilities());
  app.get('/api/v1/openapi.json', async (request) => {
    requireScope(scopes.get(request) ?? [], 'read');
    return app.swagger();
  });
  const loadSettings = async (): Promise<z.infer<typeof settingsSchema>> => {
    try {
      return settingsSchema.parse(
        JSON.parse(await readFile(join(options.root, 'settings.json'), 'utf8')),
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return settingsSchema.parse({});
      throw error;
    }
  };
  app.get(
    '/api/v1/settings',
    { schema: { response: { 200: settingsSchema } } },
    async (request) => {
      requireScope(scopes.get(request) ?? [], 'read');
      return loadSettings();
    },
  );
  app.patch(
    '/api/v1/settings',
    { schema: { body: settingsSchema, response: { 200: settingsSchema } } },
    async (request) => {
      requireScope(scopes.get(request) ?? [], 'write');
      const stage = join(options.root, randomUUID() + '.tmp');
      await writeFile(stage, JSON.stringify(request.body), { mode: 0o600 });
      await rename(stage, join(options.root, 'settings.json'));
      return request.body;
    },
  );
  app.get('/api/v1/events', async (request, reply) => {
    requireScope(scopes.get(request) ?? [], 'read');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    reply.raw.write(`id: ${sequence}\nevent: resync_required\ndata: {}\n\n`);
    clients.add(reply.raw);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(reply.raw);
    });
  });
  app.post('/mcp', async (request, reply) => {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = createMcpServer(forRequest(request));
    await mcp.connect(transport);
    reply.hijack();
    reply.raw.on('close', () => {
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  if (options.webRoot) {
    await app.register(staticFiles, { root: options.webRoot, index: 'index.html' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/mcp')
        return reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'This endpoint does not exist.',
            retryable: false,
          },
        });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('preClose', async () => {
    clearInterval(timer);
    for (const client of clients) client.end();
    await worker.stop();
  });
  app.addHook('onClose', async () => {
    await repo.close();
  });
  worker.kick();
  return { app, repo, worker, auth, service, files };
}
