import { test, expect } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

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
