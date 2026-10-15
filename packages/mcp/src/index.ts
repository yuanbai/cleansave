import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  acceptedSchema,
  annotationSchema,
  countPageSchema,
  createSchema,
  historySchema,
  inputSchema,
  jobSchema,
  listSchema,
  recordPageSchema,
  recordSchema,
} from '@cleansave/contracts';
import { CleanSaveClient, mediaDescriptorSchema, type ToolService } from '@cleansave/client';

const idSchema = z.object({ id: z.string().min(1) });

function result(value: object): {
  structuredContent: object;
  content: { type: 'text'; text: string }[];
} {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Register CleanSave tools and resource templates over an authorized library service. */
export function createMcpServer(service: ToolService): McpServer {
  const server = new McpServer({ name: 'cleansave', version: '0.1.0' });
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  server.registerTool(
    'inspect_input',
    {
      description:
        'Identify supported links in a pasted message without networking. Select explicitly if several remain.',
      inputSchema,
      annotations: read,
    },
    async ({ input }) => result({ candidates: await service.inspect(input) }),
  );
  server.registerTool(
    'save_media',
    {
      description:
        'Save or reuse a local record. Downloads and watermark-free requirements default to false. Returns job IDs, not completed media.',
      inputSchema: createSchema.extend({ requestKey: z.string().min(1).max(128).optional() }),
      outputSchema: acceptedSchema,
      annotations: write,
    },
    async ({ requestKey, ...input }) => result(await service.create(input, requestKey)),
  );
  server.registerTool(
    'list_records',
    {
      description: 'Browse/search the local library; reads never start downloads.',
      inputSchema: listSchema,
      outputSchema: recordPageSchema,
      annotations: read,
    },
    async (input) => result(await service.list(input)),
  );
  server.registerTool(
    'get_record',
    {
      description:
        'Read the latest metadata, timestamped counts and retained-file availability for a record.',
      inputSchema: idSchema,
      outputSchema: recordSchema,
      annotations: read,
    },
    async ({ id }) => result(await service.getRecord(id)),
  );
  server.registerTool(
    'update_record',
    {
      description:
        'Edit personal notes/tags using the current annotation revision. Preserves captured metadata.',
      inputSchema: idSchema.extend(annotationSchema.shape),
      outputSchema: recordSchema,
      annotations: { ...write, openWorldHint: false },
    },
    async ({ id, expectedRevision, note, tags }) =>
      result(
        await service.annotate(id, {
          expectedRevision,
          ...(note === undefined ? {} : { note }),
          ...(tags === undefined ? {} : { tags }),
        }),
      ),
  );
  server.registerTool(
    'refresh_metadata',
    {
      description:
        'Explicitly re-capture the same post: replace current source metadata and append one timestamped count observation. No media downloads.',
      inputSchema: idSchema,
      outputSchema: acceptedSchema,
      annotations: write,
    },
    async ({ id }) => result(await service.refresh(id)),
  );
  server.registerTool(
    'list_count_history',
    {
      description:
        'Read timestamped metric observations. Missing values remain null; rounded labels are not exact numbers.',
      inputSchema: idSchema.extend(historySchema.shape),
      outputSchema: countPageSchema,
      annotations: read,
    },
    async ({ id, ...input }) => result(await service.history(id, input)),
  );
  server.registerTool(
    'download_record',
    {
      description:
        'Download missing eligible media. Retry refreshes access without changing metadata or count history.',
      inputSchema: idSchema.extend({ requireNoWatermark: z.boolean().optional() }),
      outputSchema: acceptedSchema,
      annotations: write,
    },
    async ({ id, requireNoWatermark }) => result(await service.download(id, requireNoWatermark)),
  );
  server.registerTool(
    'get_job',
    {
      description:
        'Check actual job completion, progress and failure. A queued job is not a completed download.',
      inputSchema: idSchema,
      outputSchema: jobSchema,
      annotations: read,
    },
    async ({ id }) => result(await service.getJob(id)),
  );
  server.registerTool(
    'cancel_job',
    {
      description:
        'Cancel active resolution, download, or refresh, keeping completed files and count history. Destructive cleanup cannot be cancelled.',
      inputSchema: idSchema,
      outputSchema: jobSchema,
      annotations: { ...write, openWorldHint: false },
    },
    async ({ id }) => result(await service.cancelJob(id)),
  );
  server.registerTool(
    'retry_job',
    {
      description:
        'Retry a failed/interrupted job with its original intent. Metadata-refresh retries remain explicit refreshes.',
      inputSchema: idSchema,
      outputSchema: acceptedSchema,
      annotations: write,
    },
    async ({ id }) => result(await service.retryJob(id)),
  );
  server.registerTool(
    'get_media',
    {
      description:
        'Access an already-retained asset descriptor. Explicit preview embeds images up to 2 MiB. Local paths require an additional token scope.',
      inputSchema: idSchema.extend({
        preview: z.boolean().default(false),
        localPath: z.boolean().default(false),
      }),
      outputSchema: mediaDescriptorSchema,
      annotations: read,
    },
    async ({ id, preview, localPath }) => {
      const descriptor = await service.getMedia(id, localPath);
      const image = preview ? await service.preview(id) : null;
      return {
        structuredContent: descriptor,
        content: image
          ? [{ type: 'image' as const, data: image.data, mimeType: image.mime }]
          : [
              {
                type: 'resource_link' as const,
                uri: `cleansave://assets/${id}`,
                name: `Saved ${descriptor.asset.kind}`,
                mimeType: 'application/json',
                description: 'Owned asset descriptor and authenticated content address.',
              },
            ],
      };
    },
  );
  server.registerTool(
    'remove_downloads',
    {
      description:
        'Remove downloaded bytes while keeping the record, metadata, notes and count time series.',
      inputSchema: idSchema,
      outputSchema: acceptedSchema,
      annotations: { ...write, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => result(await service.removeDownloads(id)),
  );
  server.registerTool(
    'delete_record',
    {
      description:
        'Delete the specified record and its owned bytes/history. Requires delete scope.',
      inputSchema: idSchema,
      outputSchema: acceptedSchema,
      annotations: { ...write, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => result(await service.deleteRecord(id)),
  );
  server.registerTool(
    'get_capabilities',
    {
      description:
        'Read actual adapter/format limits and validation status before promising platform support.',
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => result({ capabilities: await service.capabilities() }),
  );
  server.registerResource(
    'record',
    new ResourceTemplate('cleansave://records/{id}', { list: undefined }),
    { mimeType: 'application/json' },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await service.getRecord(z.string().parse(variables.id))),
        },
      ],
    }),
  );
  server.registerResource(
    'asset',
    new ResourceTemplate('cleansave://assets/{id}', { list: undefined }),
    { mimeType: 'application/json' },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await service.getMedia(z.string().parse(variables.id))),
        },
      ],
    }),
  );
  return server;
}

/** Expose MCP over stdio by connecting to the running HTTP backend; never open SQLite here. */
export async function startStdio(options: { baseUrl: string; token: string }): Promise<void> {
  const server = createMcpServer(new CleanSaveClient(options));
  await server.connect(new StdioServerTransport());
}
