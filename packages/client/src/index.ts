import { z } from 'zod';
import {
  acceptedSchema,
  assetSchema,
  candidatesSchema,
  countPageSchema,
  type historySchema,
  jobSchema,
  type listSchema,
  recordPageSchema,
  recordSchema,
  safeErrorSchema,
  type Accepted,
  type Candidate,
  type CountCapture,
  type CreateInput,
  type JobDto,
  type RecordDto,
} from '@cleansave/contracts';

/**
 * Describe retained media using a local content URL and an optional privileged local path.
 */
export const mediaDescriptorSchema = z.object({
  asset: assetSchema,
  contentUrl: z.string(),
  localPath: z.string().optional(),
});

/** A saved asset and local access address; pairing-mode access requires backend authentication. */
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;

/** Validate adapter capabilities and runtime limits reported by the backend. */
export const capabilitiesSchema = z.object({
  adapters: z.array(
    z.object({
      platform: z.string(),
      images: z.boolean(),
      video: z.boolean(),
      method: z.string(),
      limitations: z.array(z.string()),
      validation: z.string(),
      lastLiveCheck: z.string().nullable(),
    }),
  ),
  browserRecovery: z.boolean(),
  adaptiveYouTube: z.boolean(),
  proxyPlatforms: z.array(z.string()).optional(),
  youtubeFormats: z
    .object({
      staticH264AacMux: z.boolean(),
      sabr: z.boolean(),
      hls: z.boolean(),
      dash: z.boolean(),
      drm: z.boolean(),
    })
    .optional(),
  mediaPreviewLimitBytes: z.number(),
});

/** A failed HTTP operation with a safe backend code and HTTP status. */
export class ApiError extends Error {
  /** Preserve the safe backend failure code and HTTP status for caller-specific recovery. */
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Typed REST client shared by the static frontend and stdio MCP adapter; validates every JSON
 * response.
 */
export class CleanSaveClient {
  /** Configure the backend base URL, optional bearer token, and optional fetch implementation. */
  constructor(
    private readonly options: { baseUrl: string; token?: string; fetch?: typeof fetch },
  ) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      this.options.baseUrl.replace(/\/$/, '') + path,
      {
        ...init,
        credentials: 'same-origin',
        headers: {
          ...(init.body === undefined || init.body === null
            ? {}
            : { 'content-type': 'application/json' }),
          ...(this.options.token ? { authorization: 'Bearer ' + this.options.token } : {}),
          ...init.headers,
        },
      },
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: safeErrorSchema }).safeParse(body);
      throw new ApiError(
        error.success ? error.data.error.code : 'http_error',
        error.success ? error.data.error.message : 'The local service did not accept the request.',
        response.status,
      );
    }
    return schema.parse(body);
  }

  /** Extract supported links from a pasted message without network access. */
  public async inspect(input: string): Promise<Candidate[]> {
    return this.request('/api/v1/inputs/inspect', candidatesSchema, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
  }

  /**
   * Save or reuse a record with explicit media intent; replay matching idempotency keys and reject
   * conflicting reuse.
   */
  public async create(input: CreateInput, requestKey = crypto.randomUUID()): Promise<Accepted> {
    return this.request('/api/v1/records', acceptedSchema, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey },
      body: JSON.stringify(input),
    });
  }

  /**
   * Read a record and its current metadata, annotations, count observation, and saved-file
   * receipts.
   */
  public async getRecord(id: string): Promise<RecordDto> {
    return this.request('/api/v1/records/' + encodeURIComponent(id), recordSchema);
  }

  /** Browse filtered record summaries with a cursor bound to the query and ordering. */
  public async list(
    input: z.input<typeof listSchema> = {},
  ): Promise<z.infer<typeof recordPageSchema>> {
    return this.request('/api/v1/records?' + query(input), recordPageSchema);
  }

  /** Page immutable count observations within an inclusive-from, exclusive-to time window. */
  public async history(
    id: string,
    input: z.input<typeof historySchema> = {},
  ): Promise<{ items: CountCapture[]; nextCursor: string | null }> {
    return this.request(
      `/api/v1/records/${encodeURIComponent(id)}/counts/history?` + query(input),
      countPageSchema,
    );
  }

  /** Apply personal edits only if the expected annotation revision still matches. */
  public async annotate(
    id: string,
    input: { expectedRevision: number; note?: string; tags?: string[] },
  ): Promise<RecordDto> {
    return this.request('/api/v1/records/' + encodeURIComponent(id), recordSchema, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  /**
   * Queue an explicit metadata recapture and count observation; preserve files and personal edits.
   */
  public async refresh(id: string): Promise<Accepted> {
    return this.request(
      `/api/v1/records/${encodeURIComponent(id)}/metadata/refresh`,
      acceptedSchema,
      { method: 'POST', body: '{}' },
    );
  }

  /** Queue resolution retry without replacing already-captured metadata or count history. */
  public async resolve(id: string): Promise<Accepted> {
    return this.request(`/api/v1/records/${encodeURIComponent(id)}/resolve`, acceptedSchema, {
      method: 'POST',
      body: '{}',
    });
  }

  /** Queue missing-media download; omission of the watermark policy reuses the record policy. */
  public async download(id: string, requireNoWatermark?: boolean): Promise<Accepted> {
    return this.request(`/api/v1/records/${encodeURIComponent(id)}/downloads`, acceptedSchema, {
      method: 'POST',
      body: JSON.stringify(requireNoWatermark === undefined ? {} : { requireNoWatermark }),
    });
  }

  /** Remove owned downloaded bytes while preserving metadata, annotations, and count history. */
  public async removeDownloads(id: string): Promise<Accepted> {
    return this.request(`/api/v1/records/${encodeURIComponent(id)}/downloads`, acceptedSchema, {
      method: 'DELETE',
    });
  }

  /**
   * Delete the record and its owned metadata, history, and retained files; requires deletion
   * authorization.
   */
  public async deleteRecord(id: string): Promise<Accepted> {
    return this.request('/api/v1/records/' + encodeURIComponent(id), acceptedSchema, {
      method: 'DELETE',
    });
  }

  /** Read durable operation intent, progress, and terminal error state. */
  public async getJob(id: string): Promise<JobDto> {
    return this.request('/api/v1/jobs/' + encodeURIComponent(id), jobSchema);
  }

  /** Return up to 100 recent jobs in reverse creation order. */
  public async jobs(): Promise<JobDto[]> {
    return this.request('/api/v1/jobs', z.array(jobSchema));
  }

  /** Cancel resolution, download, or refresh; irreversible deletion jobs cannot be cancelled. */
  public async cancelJob(id: string): Promise<JobDto> {
    return this.request(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, jobSchema, {
      method: 'POST',
      body: '{}',
    });
  }

  /** Retry an unsuccessful job using its original type and watermark policy. */
  public async retryJob(id: string): Promise<Accepted> {
    return this.request(`/api/v1/jobs/${encodeURIComponent(id)}/retry`, acceptedSchema, {
      method: 'POST',
      body: '{}',
    });
  }

  /**
   * Read an already-retained asset descriptor; local paths require the additional local_path scope.
   */
  public async getMedia(id: string, localPath = false): Promise<MediaDescriptor> {
    return this.request(
      `/api/v1/assets/${encodeURIComponent(id)}?localPath=${localPath}`,
      mediaDescriptorSchema,
    );
  }

  /**
   * Embed an already-retained image up to 2 MiB as base64, or return null for other formats and
   * sizes.
   */
  public async preview(id: string): Promise<{ mime: string; data: string } | null> {
    const media = await this.getMedia(id);
    if (!media.asset.mime.startsWith('image/') || media.asset.bytes > 2 * 1024 * 1024) return null;
    const response = await (this.options.fetch ?? fetch)(this.assetUrl(id), {
      credentials: 'same-origin',
      headers: this.options.token ? { authorization: 'Bearer ' + this.options.token } : {},
    });
    if (!response.ok)
      throw new ApiError('asset_not_found', 'The saved file is unavailable.', response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024)
      throw new ApiError('preview_too_large', 'Use the saved-file descriptor for this image.', 413);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { mime: media.asset.mime, data: btoa(binary) };
  }

  /** Return a local content address; pairing mode requires a session or bearer token. */
  public assetUrl(id: string): string {
    return (
      this.options.baseUrl.replace(/\/$/, '') + `/api/v1/assets/${encodeURIComponent(id)}/content`
    );
  }

  /** Read configured platform capabilities and supported format limits. */
  public async capabilities(): Promise<z.infer<typeof capabilitiesSchema>> {
    return this.request('/api/v1/capabilities', capabilitiesSchema);
  }

  /** Read persisted frontend preferences and new-record defaults. */
  public async settings(): Promise<Settings> {
    return this.request('/api/v1/settings', settingsSchema);
  }

  /** Replace persisted frontend preferences after runtime validation. */
  public async setSettings(settings: Settings): Promise<Settings> {
    return this.request('/api/v1/settings', settingsSchema, {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }

  /** Exchange the unexpired, one-use pairing secret for a process-local browser session. */
  public async pair(secret: string): Promise<void> {
    await this.request('/api/v1/session', z.object({ paired: z.literal(true) }), {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
  }
}

/** Validate saved frontend preferences and defaults for newly created records. */
export const settingsSchema = z
  .object({
    downloadContent: z.boolean().default(false),
    requireNoWatermark: z.boolean().default(false),
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    language: z.enum(['en', 'zh-CN']).default('en'),
  })
  .strict();

/**
 * Persisted appearance, language, and new-record defaults; API save defaults remain independent.
 */
export type Settings = z.infer<typeof settingsSchema>;

function query(input: object): string {
  const result = new URLSearchParams();
  for (const [name, value] of Object.entries(input))
    if (value !== undefined && value !== '') result.set(name, String(value));
  return result.toString();
}

/** Transport-independent operations exposed by MCP with backend-enforced authorization. */
export interface ToolService {
  /** Inspect input or retained-file availability without starting a download. */
  inspect(input: string): Promise<Candidate[]>;

  /**
   * Save or reuse a record with explicit media intent; replay matching idempotency keys and reject
   * conflicting reuse.
   */
  create(input: CreateInput, key?: string): Promise<Accepted>;

  /**
   * Read a record and its current metadata, annotations, count observation, and saved-file
   * receipts.
   */
  getRecord(id: string): Promise<RecordDto>;

  /** Browse filtered record summaries with a cursor bound to the query and ordering. */
  list(input?: z.input<typeof listSchema>): Promise<z.infer<typeof recordPageSchema>>;

  /** Page immutable count observations within an inclusive-from, exclusive-to time window. */
  history(
    id: string,
    input?: z.input<typeof historySchema>,
  ): Promise<{ items: CountCapture[]; nextCursor: string | null }>;

  /** Apply personal edits only if the expected annotation revision still matches. */
  annotate(
    id: string,
    input: { expectedRevision: number; note?: string; tags?: string[] },
  ): Promise<RecordDto>;

  /**
   * Queue an explicit metadata recapture and count observation; preserve files and personal edits.
   */
  refresh(id: string): Promise<Accepted>;

  /** Queue missing-media download; omission of the watermark policy reuses the record policy. */
  download(id: string, policy?: boolean): Promise<Accepted>;

  /** Read durable operation intent, progress, and terminal error state. */
  getJob(id: string): Promise<JobDto>;

  /** Cancel resolution, download, or refresh; irreversible deletion jobs cannot be cancelled. */
  cancelJob(id: string): Promise<JobDto>;

  /** Retry an unsuccessful job using its original type and watermark policy. */
  retryJob(id: string): Promise<Accepted>;

  /**
   * Read an already-retained asset descriptor; local paths require the additional local_path scope.
   */
  getMedia(id: string, localPath?: boolean): Promise<MediaDescriptor>;

  /**
   * Embed an already-retained image up to 2 MiB as base64, or return null for other formats and
   * sizes.
   */
  preview(id: string): Promise<{ mime: string; data: string } | null>;

  /** Remove owned downloaded bytes while preserving metadata, annotations, and count history. */
  removeDownloads(id: string): Promise<Accepted>;

  /**
   * Delete the record and its owned metadata, history, and retained files; requires deletion
   * authorization.
   */
  deleteRecord(id: string): Promise<Accepted>;

  /** Read configured platform capabilities and supported format limits. */
  capabilities(): Promise<unknown>;
}
