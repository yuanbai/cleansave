import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { isolatedTask } from '@cleansave/core/task';
import { mediaFixture } from '../tests/media-fixture.js';
const artifact = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the isolated deployed package directory.');
const dataRoot = await mkdtemp(join(tmpdir(), 'cleansave-package-library-'));
const child = spawn(
  process.execPath,
  [join(artifact, 'dist/cli.js'), '--data-dir', dataRoot, '--port', '4791'],
  { cwd: artifact, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
let diagnostics = '';
child.stdout.on('data', (chunk: Buffer) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk: Buffer) => {
  diagnostics += chunk.toString();
});
const client = new Client({ name: 'isolated-package-check', version: '1' });
try {
  for (let attempt = 0; !output.includes('CleanSave is running.') && attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Packaged backend exited: ' + diagnostics);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(!output.includes('#pair='));
  const health = await fetch('http://127.0.0.1:4791/health');
  assert.equal(health.status, 200);
  const page = await fetch('http://127.0.0.1:4791/');
  const html = await page.text();
  assert.equal(page.status, 200);
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset);
  assert.equal((await fetch('http://127.0.0.1:4791' + asset)).status, 200);
  assert.ok(await readFile(join(dataRoot, 'library.sqlite')));
  const records = await fetch('http://127.0.0.1:4791/api/v1/records');
  assert.equal(records.status, 200);
  assert.deepEqual(await records.json(), { items: [], nextCursor: null });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        join(artifact, 'dist/cli.js'),
        'mcp',
        '--data-dir',
        dataRoot,
        '--base-url',
        'http://127.0.0.1:4791',
      ],
      cwd: artifact,
      stderr: 'pipe',
    }),
  );
  const result = await client.callTool({ name: 'list_records', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { items: [], nextCursor: null });
  const usage = await client.callTool({ name: 'get_storage_usage', arguments: {} });
  assert.notEqual(usage.isError, true);
  assert.deepEqual(usage.structuredContent, { downloadBytes: 0, downloadedFiles: 0 });
  const guest = await isolatedTask(
    pathToFileURL(join(artifact, 'dist/youtube-worker.js')),
    { kind: 'evaluate', code: '({marker:"worker-ok", host:typeof process})' },
    z.object({ marker: z.string(), host: z.string() }),
    AbortSignal.timeout(5000),
    2000,
  );
  assert.deepEqual(guest, { marker: 'worker-ok', host: 'undefined' });
  const media = await mediaFixture(dataRoot);
  const muxed = await isolatedTask(
    pathToFileURL(join(artifact, 'dist/mux-worker.js')),
    {
      video: media.videoPath,
      audio: media.audioPath,
      output: join(dataRoot, 'package-mux.mp4'),
      maxBytes: 1024 * 1024,
    },
    z.object({ bytes: z.number(), sha256: z.string() }),
    AbortSignal.timeout(10000),
    5000,
  );
  const bytes = await readFile(join(dataRoot, 'package-mux.mp4'));
  assert.equal(bytes.length, muxed.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), muxed.sha256);
  process.stdout.write(
    'Isolated package: backend, SQLite, static app/assets, stdio MCP, QuickJS and mux workers passed.\n',
  );
} finally {
  await client.close();
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  await rm(dataRoot, { recursive: true, force: true });
}
