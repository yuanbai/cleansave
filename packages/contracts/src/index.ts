import { z } from 'zod';

/** The social platforms accepted by input inspection and record storage. */
export const platformSchema = z.enum(['douyin', 'xiaohongshu', 'kuaishou', 'tiktok', 'youtube']);

/** A supported platform identifier shared across adapters and public APIs. */
export type Platform = z.infer<typeof platformSchema>;

/** Public managed-service status; excludes filesystem paths, launch arguments, and credentials. */
export const serviceStatusSchema = z.object({
  state: z.enum(['running', 'stopping', 'starting', 'unreachable', 'stopped', 'unmanaged']),
  managed: z.boolean(),
  url: z.url(),
  pid: z.number().int().positive().optional(),
  startedAt: z.iso.datetime().optional(),
});

/** A local service lifecycle result suitable for scoped MCP callers. */
export type ServiceStatusDto = z.infer<typeof serviceStatusSchema>;

/** Stable display and iteration order for engagement metrics. */
export const metricNames = ['likes', 'comments', 'shares', 'favorites', 'views'] as const;

/** A supported engagement metric; upstream availability varies by platform and post. */
export type MetricName = (typeof metricNames)[number];

/**
 * Represent exact counts as decimal strings and rounded counts as their original display labels.
 */
export const countSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), value: z.string().regex(/^\d+$/) }),
  z.object({ kind: z.literal('rounded'), display: z.string().min(1).max(40) }),
]);

/** An exact nonnegative integer or a rounded upstream label; never infer an exact rounded value. */
export type Count = z.infer<typeof countSchema>;

/** A metric observation with null for each unavailable count, rather than a fabricated zero. */
export const countsSchema = z.object({
  likes: countSchema.nullable(),
  comments: countSchema.nullable(),
  shares: countSchema.nullable(),
  favorites: countSchema.nullable(),
  views: countSchema.nullable(),
});

/** All engagement metrics from one capture, including unavailable values. */
export type Counts = z.infer<typeof countsSchema>;

/** Validate one immutable, timestamped set of counts for a record. */
export const countCaptureSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  capturedAt: z.iso.datetime(),
  adapterVersion: z.string(),
  counts: countsSchema,
});

/** A timestamped observation appended by initial capture or an explicit metadata refresh. */
export type CountCapture = z.infer<typeof countCaptureSchema>;

/**
 * Current source metadata; refresh replaces this snapshot while count history remains immutable.
 */
export const metadataSchema = z.object({
  title: z.string(),
  description: z.string(),
  canonicalUrl: z.url(),
  author: z.object({
    name: z.string().nullable(),
    handle: z.string().nullable(),
    id: z.string().nullable(),
    profileUrl: z.url().nullable(),
  }),
  publishedAt: z.iso.datetime().nullable(),
  capturedAt: z.iso.datetime(),
  adapterVersion: z.string(),
  warnings: z.array(z.string()),
});

/** The latest captured source attributes, separate from personal notes and tags. */
export type Metadata = z.infer<typeof metadataSchema>;

/** An ordered media slot with a pinned variant identity; includes unavailable primary items. */
export const mediaSchema = z.object({
  itemId: z.string(),
  variantId: z.string(),
  sourceKey: z.string().nullable(),
  kind: z.enum(['image', 'video']),
  position: z.number().int().nonnegative(),
  required: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  codec: z.string().nullable(),
  expectedBytes: z.number().int().positive().nullable(),
  watermarkStatus: z.enum(['clean', 'watermarked', 'unknown']),
  provenance: z.enum(['original', 'playback', 'download', 'cover', 'derived_mux']),
  evidence: z.string(),
});

/** A source media identity and eligibility evidence, without an expiring download URL. */
export type Media = z.infer<typeof mediaSchema>;

/** A transport-safe operational error without credentials, raw inputs, or upstream bodies. */
export const safeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

/** A public error code, actionable message, and retryability indication. */
export type SafeError = z.infer<typeof safeErrorSchema>;

/** Integrity and variant receipts for the separate inputs of a derived MP4. */
export const inputReceiptSchema = z.object({
  role: z.enum(['video', 'audio']),
  variantId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceKey: z
    .string()
    .max(512)
    .regex(/^[\w:+.-]+$/),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** A retained-file receipt; derived media must identify both verified input tracks. */
export const assetSchema = z
  .object({
    id: z.string(),
    recordId: z.string(),
    itemId: z.string(),
    variantId: z.string(),
    kind: z.enum(['image', 'video']),
    state: z.enum(['complete', 'missing_on_disk']),
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    completedAt: z.iso.datetime(),
    watermarkStatus: z.enum(['clean', 'watermarked', 'unknown']),
    required: z.boolean(),
    validation: z.string(),
    provenance: z.enum(['direct', 'derived_mux']).default('direct'),
    inputReceipts: z.array(inputReceiptSchema).max(2).default([]),
  })
  .refine(
    (asset) =>
      asset.provenance === 'direct'
        ? asset.inputReceipts.length === 0
        : asset.inputReceipts.length === 2 &&
          new Set(asset.inputReceipts.map((receipt) => receipt.role)).size === 2,
    { message: 'Derived media requires separate video and audio receipts.' },
  );

/** A saved file with SHA-256 integrity, availability, and source or mux provenance. */
export type Asset = z.infer<typeof assetSchema>;

/** The public record allowlist used by REST, MCP, manifests, and the web app. */
export const recordSchema = z.object({
  id: z.string(),
  originalUrl: z.url(),
  savedAt: z.iso.datetime(),
  firstCapturedAt: z.iso.datetime().nullable(),
  platform: platformSchema,
  postId: z.string().nullable(),
  metadata: metadataSchema.nullable(),
  metadataRevision: z.number().int().nonnegative(),
  counts: countCaptureSchema.nullable(),
  media: z.array(mediaSchema),
  assets: z.array(assetSchema),
  note: z.string(),
  tags: z.array(z.string()),
  annotationRevision: z.number().int().nonnegative(),
  annotationDrafts: z.array(z.object({ note: z.string(), tags: z.array(z.string()) })),
  options: z.object({ downloadContent: z.boolean(), requireNoWatermark: z.boolean() }),
  resolutionState: z.enum(['queued', 'resolving', 'resolved', 'failed']),
  downloadState: z.enum([
    'not_requested',
    'queued',
    'downloading',
    'complete',
    'partial',
    'failed',
    'cancelled',
  ]),
  error: safeErrorSchema.nullable(),
  refreshError: safeErrorSchema.nullable(),
  activeJobIds: z.array(z.string()),
  mergedIntoId: z.string().nullable(),
});

/** A public library record containing metadata, annotations, counts, and saved-file receipts. */
export type RecordDto = z.infer<typeof recordSchema>;

/** The public job lifecycle and progress contract, including its effective watermark policy. */
export const jobSchema = z.object({
  id: z.string(),
  recordId: z.string(),
  type: z.enum(['resolve', 'download', 'refresh', 'remove_downloads', 'delete']),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  requireNoWatermark: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(),
  totalItems: z.number().int().nonnegative(),
  error: safeErrorSchema.nullable(),
});

/** An asynchronous operation; acceptance does not imply successful resolution or download. */
export type JobDto = z.infer<typeof jobSchema>;

/** Accept a bounded pasted URL or share message and reject unrecognized input fields. */
export const inputSchema = z.object({ input: z.string().min(1).max(16384) }).strict();

/** Validate save intent; downloading and requiring watermark-free sources both default to false. */
export const createSchema = inputSchema.extend({
  selectedUrl: z.url().optional(),
  downloadContent: z.boolean().default(false),
  requireNoWatermark: z.boolean().default(false),
});

/** Save input with an optional explicit candidate selection and media download policy. */
export type CreateInput = z.input<typeof createSchema>;

/** Validate personal edits with an expected revision to prevent overwriting concurrent changes. */
export const annotationSchema = z
  .object({
    note: z.string().max(20000).optional(),
    tags: z.array(z.string().min(1).max(80)).max(50).optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

/** An optional watermark policy; omission reuses the record policy. */
export const downloadSchema = z.object({ requireNoWatermark: z.boolean().optional() }).strict();

/** Validate library filters and stable cursor pagination; defaults to 30 newest records. */
export const listSchema = z.object({
  query: z.string().max(256).default(''),
  platform: platformSchema.optional(),
  kind: z.enum(['image', 'video']).optional(),
  state: z.string().optional(),
  tag: z.string().max(80).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Normalized library filters, ordering, page size, and optional query-bound cursor. */
export type ListQuery = z.infer<typeof listSchema>;

/** Validate count-history pagination and an inclusive-from, exclusive-to time window. */
export const historySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Normalized count-history selection; defaults to 100 observations in ascending time order. */
export type HistoryQuery = z.infer<typeof historySchema>;

/** An accepted asynchronous request or reused record; jobId can be null when no work is needed. */
export const acceptedSchema = z.object({
  recordId: z.string(),
  jobId: z.string().nullable(),
  reused: z.boolean(),
});

/** The durable record ID, optional job ID, and duplicate-reuse result of an operation. */
export type Accepted = z.infer<typeof acceptedSchema>;

/** Supported, normalized links extracted from a pasted message without network access. */
export const candidatesSchema = z.array(z.object({ url: z.url(), platform: platformSchema }));

/** One explicitly selectable platform URL from the original input. */
export type Candidate = z.infer<typeof candidatesSchema>[number];

/** Compact library results with saved-file availability and no full metadata or asset arrays. */
export const recordSummarySchema = recordSchema
  .pick({
    id: true,
    platform: true,
    postId: true,
    savedAt: true,
    counts: true,
    tags: true,
    resolutionState: true,
    downloadState: true,
    error: true,
    activeJobIds: true,
  })
  .extend({
    title: z.string(),
    author: z.string(),
    capturedAt: z.iso.datetime().nullable(),
    kind: z.enum(['image', 'video']).nullable(),
    itemCount: z.number().int().nonnegative(),
    retainedCount: z.number().int().nonnegative(),
    previewAssetId: z.string().nullable(),
  });

/** A library card or list row; fetch the record for complete metadata and receipts. */
export type RecordSummary = z.infer<typeof recordSummarySchema>;

/** A page of record summaries and an opaque cursor for the next matching page. */
export const recordPageSchema = z.object({
  items: z.array(recordSummarySchema),
  nextCursor: z.string().nullable(),
});

/** A page of immutable count observations and an opaque continuation cursor. */
export const countPageSchema = z.object({
  items: z.array(countCaptureSchema),
  nextCursor: z.string().nullable(),
});

/** Create a fresh observation with every metric unavailable. */
export const emptyCounts = (): Counts => ({
  likes: null,
  comments: null,
  shares: null,
  favorites: null,
  views: null,
});
