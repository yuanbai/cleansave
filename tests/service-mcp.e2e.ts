import { test, expect, chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serviceStatusSchema, recordSchema, countPageSchema } from '@cleansave/contracts';
import { capabilitiesSchema } from '@cleansave/client';
import { Auth } from '../apps/server/src/auth.js';
import { fixtureBackend, image } from './helpers.js';

const execute = promisify(execFile);
const cli = resolve('dist/cli.js');
const lifecycleTools = ['get_service_status', 'start_service', 'stop_service', 'restart_service'];

async function command(root: string, action: string, args: string[] = [], env = process.env) {
  return execute(process.execPath, [cli, 'service', action, '--data-dir', root, ...args], {
    env,
    timeout: 25000,
  });
}

async function connect(root: string, env: Record<string, string> = {}) {
  const client = new Client({ name: 'cleansave-service-lifecycle-check', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--data-dir', root, '--base-url', 'http://127.0.0.1:4797'],
      env,
      stderr: 'pipe',
    }),
  );
  return client;
}

test('stdio MCP survives stop/restart and preserves settings, files, annotations, and count history', async () => {
  test.setTimeout(45000);
  const seed = await fixtureBackend();
  const { recordId } = await seed.save(true);
  await seed.settled();
  await seed.app.close();
  const root = seed.root;
  const client = new Client({ name: 'cleansave-service-owner', version: '1' });
  const http = new Client({ name: 'cleansave-service-http', version: '1' });
  try {
    await command(root, 'start', ['--port', '4797'], {
      ...process.env,
      CLEANSAVE_REQUIRE_PAIRING: '1',
      CLEANSAVE_PROXY: 'http://127.0.0.1:18081',
      CLEANSAVE_PROXY_PLATFORMS: 'youtube,tiktok',
      CLEANSAVE_BROWSER: process.env.CLEANSAVE_CHROME ?? chromium.executablePath(),
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', '--data-dir', root, '--base-url', 'http://127.0.0.1:4797'],
        env: {
          CLEANSAVE_REQUIRE_PAIRING: '0',
          CLEANSAVE_PROXY: 'http://127.0.0.1:18082',
          CLEANSAVE_PROXY_PLATFORMS: 'douyin',
        },
        stderr: 'pipe',
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(lifecycleTools),
    );
    const call = (name: string) => client.callTool({ name, arguments: {} });
    const initial = serviceStatusSchema.parse((await call('get_service_status')).structuredContent);
    expect(initial.state).toBe('running');
    expect(initial.managed).toBe(true);
    const configuration = await readFile(join(root, 'service-config.json'), 'utf8');
    if (process.platform !== 'win32')
      expect((await stat(join(root, 'service-config.json'))).mode & 0o777).toBe(0o600);
    const state = z
      .object({ token: z.string() })
      .parse(JSON.parse(await readFile(join(root, 'service.json'), 'utf8')));
    expect(JSON.stringify(initial)).not.toContain(root);
    expect(JSON.stringify(initial)).not.toContain('controlPort');
    expect(JSON.stringify(initial)).not.toContain(state.token);
    const before = recordSchema.parse(
      (await client.callTool({ name: 'get_record', arguments: { id: recordId } }))
        .structuredContent,
    );
    const edited = await client.callTool({
      name: 'update_record',
      arguments: {
        id: recordId,
        expectedRevision: before.annotationRevision,
        note: 'Keep this note',
        tags: ['retained'],
      },
    });
    expect(edited.isError).not.toBe(true);
    const retained = recordSchema.parse(edited.structuredContent);
    const history = countPageSchema.parse(
      (await client.callTool({ name: 'list_count_history', arguments: { id: recordId } }))
        .structuredContent,
    );
    expect(history.items).toHaveLength(1);
    const capabilities = async () =>
      z
        .object({ capabilities: capabilitiesSchema })
        .parse(
          (await client.callTool({ name: 'get_capabilities', arguments: {} })).structuredContent,
        ).capabilities;
    expect((await capabilities()).proxyPlatforms).toEqual(['youtube', 'tiktok']);
    expect((await capabilities()).browserRecovery).toBe(true);
    expect((await fetch(initial.url + '/api/v1/records')).status).toBe(401);
    const badInput = await client.callTool({ name: 'restart_service', arguments: { port: 4777 } });
    expect(badInput.isError).toBe(true);
    expect(
      serviceStatusSchema.parse((await call('get_service_status')).structuredContent).pid,
    ).toBe(initial.pid);
    try {
      await rm(join(root, 'service-config.json'));
      expect((await call('restart_service')).isError).toBe(true);
      expect(
        serviceStatusSchema.parse((await call('get_service_status')).structuredContent).pid,
      ).toBe(initial.pid);
    } finally {
      await writeFile(join(root, 'service-config.json'), configuration, { mode: 0o600 });
    }
    const restarted = serviceStatusSchema.parse((await call('restart_service')).structuredContent);
    expect(restarted.state).toBe('running');
    expect(restarted.pid).not.toBe(initial.pid);
    expect((await capabilities()).proxyPlatforms).toEqual(['youtube', 'tiktok']);
    const concurrent = await Promise.all([call('restart_service'), call('restart_service')]);
    for (const result of concurrent)
      expect(serviceStatusSchema.parse(result.structuredContent).state).toBe('running');
    expect(
      (await client.callTool({ name: 'get_record', arguments: { id: recordId } })).isError,
    ).not.toBe(true);
    expect((await capabilities()).browserRecovery).toBe(true);
    expect((await fetch(initial.url + '/api/v1/records')).status).toBe(401);
    expect(await readFile(join(root, 'service-config.json'), 'utf8')).toBe(configuration);
    expect(
      recordSchema.parse(
        (await client.callTool({ name: 'get_record', arguments: { id: recordId } }))
          .structuredContent,
      ),
    ).toEqual(retained);
    expect(
      countPageSchema.parse(
        (await client.callTool({ name: 'list_count_history', arguments: { id: recordId } }))
          .structuredContent,
      ),
    ).toEqual(history);
    const asset = retained.assets[0];
    if (!asset) throw new Error('Missing retained fixture');
    const content = await fetch(initial.url + `/api/v1/assets/${asset.id}/content`, {
      headers: { authorization: 'Bearer ' + seed.token },
    });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(image);
    await http.connect(
      new StreamableHTTPClientTransport(new URL(initial.url + '/mcp'), {
        requestInit: { headers: { authorization: 'Bearer ' + seed.token } },
      }),
    );
    for (const tool of (await http.listTools()).tools)
      expect(lifecycleTools).not.toContain(tool.name);
    await http.close();
    expect(serviceStatusSchema.parse((await call('stop_service')).structuredContent).state).toBe(
      'stopped',
    );
    expect(
      serviceStatusSchema.parse((await call('get_service_status')).structuredContent).state,
    ).toBe('stopped');
    expect(serviceStatusSchema.parse((await call('stop_service')).structuredContent).state).toBe(
      'stopped',
    );
    expect((await client.callTool({ name: 'list_records', arguments: {} })).isError).toBe(true);
    await expect(access(join(root, 'owner.lock'))).rejects.toThrow();
    // During restart the old process can be gone while an operation still owns the library's
    // lifecycle lease. A stop must wait for that operation instead of acknowledging prematurely.
    const lease = join(root, 'service-start.lock');
    await mkdir(lease);
    await writeFile(
      join(lease, 'owner.json'),
      JSON.stringify({ id: randomUUID(), pid: process.pid }),
    );
    const pendingStop = call('stop_service');
    try {
      expect(
        await Promise.race([pendingStop.then(() => 'finished'), delay(200).then(() => 'waiting')]),
      ).toBe('waiting');
    } finally {
      await rm(lease, { recursive: true, force: true });
    }
    expect(serviceStatusSchema.parse((await pendingStop).structuredContent).state).toBe('stopped');
    expect(serviceStatusSchema.parse((await call('start_service')).structuredContent).state).toBe(
      'running',
    );
    expect(
      (await client.callTool({ name: 'get_record', arguments: { id: recordId } })).isError,
    ).not.toBe(true);
    await command(root, 'restart');
    expect(
      serviceStatusSchema.parse((await call('get_service_status')).structuredContent).state,
    ).toBe('running');
    expect((await capabilities()).proxyPlatforms).toEqual(['youtube', 'tiktok']);
  } finally {
    await client.close();
    await http.close();
    await command(root, 'stop');
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP lifecycle controls honor read-only, invalid, revoked, and mismatched credentials while offline', async () => {
  const seed = await fixtureBackend();
  await seed.app.close();
  const root = seed.root;
  const clients: Client[] = [];
  try {
    await command(root, 'start', ['--port', '4797'], {
      ...process.env,
      CLEANSAVE_REQUIRE_PAIRING: '0',
    });
    const auth = new Auth(root);
    const readerToken = await auth.mint('lifecycle-reader', ['read']);
    const reader = await connect(root, { CLEANSAVE_TOKEN: readerToken });
    clients.push(reader);
    expect((await reader.callTool({ name: 'get_service_status', arguments: {} })).isError).not.toBe(
      true,
    );
    for (const name of lifecycleTools.slice(1))
      expect((await reader.callTool({ name, arguments: {} })).isError).toBe(true);
    const invalid = await connect(root, { CLEANSAVE_TOKEN: 'invalid-test-token' });
    clients.push(invalid);
    for (const name of lifecycleTools)
      expect((await invalid.callTool({ name, arguments: {} })).isError).toBe(true);
    const wrongUrl = new Client({ name: 'cleansave-wrong-service-url', version: '1' });
    clients.push(wrongUrl);
    await wrongUrl.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', '--data-dir', root, '--base-url', 'http://127.0.0.1:4798'],
        stderr: 'pipe',
      }),
    );
    expect((await wrongUrl.callTool({ name: 'restart_service', arguments: {} })).isError).toBe(
      true,
    );
    expect((await fetch('http://127.0.0.1:4797/health')).status).toBe(200);
    await command(root, 'stop');
    expect(
      serviceStatusSchema.parse(
        (await reader.callTool({ name: 'get_service_status', arguments: {} })).structuredContent,
      ).state,
    ).toBe('stopped');
    for (const name of lifecycleTools.slice(1))
      expect((await reader.callTool({ name, arguments: {} })).isError).toBe(true);
    await auth.revoke('lifecycle-reader');
    expect((await reader.callTool({ name: 'get_service_status', arguments: {} })).isError).toBe(
      true,
    );
    expect((await reader.callTool({ name: 'start_service', arguments: {} })).isError).toBe(true);
    await expect(access(join(root, 'owner.lock'))).rejects.toThrow();
  } finally {
    for (const client of clients) await client.close();
    await command(root, 'stop');
    await rm(root, { recursive: true, force: true });
  }
});
