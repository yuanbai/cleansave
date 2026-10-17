import { test, expect } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { historySchema, storageUsageSchema, type StorageUsage } from '@cleansave/contracts';
import { fixtureBackend, image } from './helpers.js';

test('production stdio artifact and HTTP MCP share the actual backend library', async () => {
  const runtime = z
    .object({ root: z.string(), token: z.string() })
    .parse(JSON.parse(await readFile('.test-runtime.json', 'utf8')));
  const isolated = await mkdtemp(join(tmpdir(), 'cleansave-package-'));
  await cp('dist', join(isolated, 'dist'), { recursive: true });
  const { symlink } = await import('node:fs/promises');
  await symlink(
    join(process.cwd(), 'node_modules'),
    join(isolated, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const stdio = new Client({ name: 'cleansave-acceptance', version: '1' });
  const http = new Client({ name: 'cleansave-http-acceptance', version: '1' });
  const anonymous = new Client({ name: 'cleansave-local-acceptance', version: '1' });
  try {
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          join(isolated, 'dist/cli.js'),
          'mcp',
          '--data-dir',
          runtime.root,
          '--base-url',
          'http://127.0.0.1:4788',
        ],
        stderr: 'inherit',
      }),
    );
    const tools = await stdio.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('list_count_history');
    expect(tools.tools.map((tool) => tool.name)).toContain('get_storage_usage');
    const inspected = await stdio.callTool({
      name: 'inspect_input',
      arguments: { input: 'https://www.douyin.com/video/888' },
    });
    expect(inspected.isError).not.toBe(true);
    const saved = await stdio.callTool({
      name: 'save_media',
      arguments: { input: 'https://www.douyin.com/video/888' },
    });
    expect(saved.isError).not.toBe(true);
    const accepted = z
      .object({ recordId: z.string(), jobId: z.string() })
      .parse(saved.structuredContent);
    await expect
      .poll(async () => {
        const job = await stdio.callTool({ name: 'get_job', arguments: { id: accepted.jobId } });
        return z.object({ state: z.string() }).parse(job.structuredContent).state;
      })
      .toBe('succeeded');
    await http.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4788/mcp'), {
        requestInit: { headers: { authorization: 'Bearer ' + runtime.token } },
      }),
    );
    const record = await http.callTool({
      name: 'get_record',
      arguments: { id: accepted.recordId },
    });
    expect(record.isError).not.toBe(true);
    await anonymous.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4788/mcp')),
    );
    const localRecord = await anonymous.callTool({
      name: 'get_record',
      arguments: { id: accepted.recordId },
    });
    expect(localRecord.isError).not.toBe(true);
    const response = await fetch('http://127.0.0.1:4788/api/v1/storage');
    expect(response.status).toBe(200);
    const totals = storageUsageSchema.parse(await response.json());
    for (const client of [stdio, http, anonymous]) {
      const usage = await client.callTool({ name: 'get_storage_usage', arguments: {} });
      expect(usage.isError).not.toBe(true);
      expect(storageUsageSchema.parse(usage.structuredContent)).toEqual(totals);
    }
    expect(z.object({ postId: z.string() }).parse(record.structuredContent).postId).toBe('888');
    const forbidden = await http.callTool({
      name: 'delete_record',
      arguments: { id: accepted.recordId },
    });
    expect(forbidden.isError).toBe(true);
    const history = await http.callTool({
      name: 'list_count_history',
      arguments: { id: accepted.recordId },
    });
    expect(
      z.object({ items: z.array(z.unknown()) }).parse(history.structuredContent).items,
    ).toHaveLength(1);
  } finally {
    await stdio.close();
    await http.close();
    await anonymous.close();
    await rm(isolated, { recursive: true, force: true });
  }
});

test('storage MCP is read-only, requires read scope on both transports, and reflects downloads and removal', async () => {
  const backend = await fixtureBackend(undefined, { port: 4793, requirePairing: true });
  const base = 'http://127.0.0.1:4793';
  const clients: Client[] = [];
  try {
    await backend.app.listen({ host: '127.0.0.1', port: 4793 });
    const readers: Client[] = [];
    const writers: Client[] = [];
    for (const scope of ['read', 'write'] as const) {
      const token = await backend.auth.mint('storage-' + scope, [scope]);
      for (const transport of [
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('dist/cli.js'), 'mcp', '--data-dir', backend.root, '--base-url', base],
          env: { CLEANSAVE_TOKEN: token },
          stderr: 'pipe',
        }),
        new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { authorization: 'Bearer ' + token } },
        }),
      ]) {
        const client = new Client({ name: 'storage-' + scope, version: '1' });
        clients.push(client);
        await client.connect(transport);
        (scope === 'read' ? readers : writers).push(client);
        const tool = (await client.listTools()).tools.find(
          (entry) => entry.name === 'get_storage_usage',
        );
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
    }
    const expectUsage = async (expected: StorageUsage) => {
      for (const client of readers) {
        const usage = await client.callTool({ name: 'get_storage_usage', arguments: {} });
        expect(usage.isError).not.toBe(true);
        expect(usage.structuredContent).toEqual(expected);
        expect(usage.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
      }
      for (const client of writers) {
        const denied = await client.callTool({ name: 'get_storage_usage', arguments: {} });
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toBeUndefined();
      }
    };
    await expectUsage({ downloadBytes: 0, downloadedFiles: 0 });
    const input = { input: 'https://www.douyin.com/video/12345' };
    const saved = await backend.service(['write']).create(input);
    await backend.settled();
    const metadataOnly = await backend.repo.get(saved.recordId);
    const firstJobs = await backend.repo.jobs();
    await expectUsage({ downloadBytes: 0, downloadedFiles: 0 });
    expect(await backend.repo.get(saved.recordId)).toEqual(metadataOnly);
    expect(await backend.repo.jobs()).toEqual(firstJobs);

    await backend.service(['write']).create({ ...input, downloadContent: true });
    await backend.settled();
    const retained = await backend.repo.get(saved.recordId);
    const history = await backend.repo.history(saved.recordId, historySchema.parse({}));
    const jobs = await backend.repo.jobs();
    await expectUsage({ downloadBytes: image.length, downloadedFiles: 1 });
    expect(await backend.repo.get(saved.recordId)).toEqual(retained);
    expect(await backend.repo.history(saved.recordId, historySchema.parse({}))).toEqual(history);
    expect(await backend.repo.jobs()).toEqual(jobs);
    for (const client of readers) {
      const invalid = await client.callTool({
        name: 'get_storage_usage',
        arguments: { limit: 1 },
      });
      expect(invalid.isError).toBe(true);
    }

    await backend.service(['delete']).removeDownloads(saved.recordId);
    await backend.settled();
    await expectUsage({ downloadBytes: 0, downloadedFiles: 0 });
  } finally {
    for (const client of clients) await client.close();
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});
