import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const cli = resolve('dist/cli.js');
const statusSchema = z.object({
  state: z.string(),
  pid: z.number().optional(),
  url: z.string().optional(),
  dataDirectory: z.string(),
  logFile: z.string(),
  mcp: z.object({ command: z.string(), args: z.array(z.string()) }).optional(),
  mcpVerified: z.boolean().optional(),
});

async function service(root: string, action: string, args: string[] = []) {
  const result = await execute(
    process.execPath,
    [cli, 'service', action, '--data-dir', root, ...args],
    { cwd: tmpdir(), timeout: 22000, env: { ...process.env, CLEANSAVE_REQUIRE_PAIRING: '0' } },
  );
  return statusSchema.parse(JSON.parse(result.stdout));
}

test('background service survives its launcher, reuses one owner, verifies MCP, and retains data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleansave service '));
  try {
    // Competing setup attempts must converge on one worker and one token file.
    const [first, repeated] = await Promise.all([
      service(root, 'start', ['--port', '4797']),
      service(root, 'start', ['--port', '4797']),
    ]);
    expect(first.state).toBe('running');
    expect(repeated.pid).toBe(first.pid);
    expect(first.dataDirectory).toBe(await realpath(root));
    expect(first.mcp).toEqual({
      command: process.execPath,
      args: [cli, 'mcp', '--base-url', 'http://127.0.0.1:4797', '--data-dir', await realpath(root)],
    });
    const token = await readFile(join(root, 'credentials/agent-token.txt'), 'utf8');
    expect(JSON.stringify(first)).not.toContain(token.trim());
    const stateText = await readFile(join(root, 'service.json'), 'utf8');
    const state = z.object({ token: z.string() }).parse(JSON.parse(stateText));
    expect(JSON.stringify(first)).not.toContain(state.token);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'service.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(first.logFile)).mode & 0o777).toBe(0o600);
    }
    expect((await service(root, 'status', ['--verify-mcp'])).mcpVerified).toBe(true);
    const settings = await fetch(first.url + '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'zh-CN', theme: 'dark', downloadContent: true }),
    });
    expect(settings.status).toBe(200);
    const savedSettings: unknown = await settings.json();
    expect((await service(root, 'stop')).state).toBe('stopped');
    expect((await service(root, 'stop')).state).toBe('stopped');
    const restarted = await service(root, 'start', ['--port', '4797']);
    expect(restarted.state).toBe('running');
    expect(restarted.pid).not.toBe(first.pid);
    expect(await readFile(join(root, 'credentials/agent-token.txt'), 'utf8')).toBe(token);
    expect(await (await fetch(restarted.url + '/api/v1/settings')).json()).toEqual(savedSettings);
    const currentState = await readFile(join(root, 'service.json'), 'utf8');
    const current = z.object({ token: z.string(), id: z.string() }).parse(JSON.parse(currentState));
    try {
      // Authentication failure cannot fall back to an unauthenticated control operation.
      await writeFile(
        join(root, 'service.json'),
        currentState.replace(current.token, '0'.repeat(64)),
      );
      expect((await service(root, 'status')).state).toBe('unreachable');
      await expect(service(root, 'stop')).rejects.toThrow();
      expect((await fetch(restarted.url + '/health')).status).toBe(200);
      await writeFile(join(root, 'service.json'), currentState.replace(current.id, randomUUID()));
      await expect(service(root, 'stop')).rejects.toThrow();
      expect((await fetch(restarted.url + '/health')).status).toBe(200);
    } finally {
      await writeFile(join(root, 'service.json'), currentState);
    }
  } finally {
    await service(root, 'stop');
    await rm(root, { recursive: true, force: true });
  }
});

test('service refuses unrelated foreground owners and port occupants, and recovers dead state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleansave-service-conflict-'));
  const child = spawn(process.execPath, [cli, 'start', '--data-dir', root, '--port', '4797'], {
    env: { ...process.env, CLEANSAVE_REQUIRE_PAIRING: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  try {
    await expect.poll(() => output.includes('CleanSave is running.')).toBe(true);
    await expect(service(root, 'start', ['--port', '4798'])).rejects.toThrow();
    expect((await service(root, 'stop')).state).toBe('stopped');
    expect(child.exitCode).toBeNull();
    expect((await fetch('http://127.0.0.1:4797/health')).status).toBe(200);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  const occupant = createServer((_request, response) => response.end('unrelated'));
  try {
    await new Promise<void>((done) => occupant.listen(4797, '127.0.0.1', done));
    await expect(service(root, 'start', ['--port', '4797'])).rejects.toThrow();
    expect(await (await fetch('http://127.0.0.1:4797')).text()).toBe('unrelated');
  } finally {
    await new Promise<void>((done) => occupant.close(() => done()));
  }
  try {
    // A live unrelated PID never authorizes stop, even with plausible metadata.
    const state = {
      id: randomUUID(),
      token: '0'.repeat(64),
      pid: process.pid,
      controlPort: 4799,
      port: 4797,
      cli,
      node: process.execPath,
      startedAt: new Date().toISOString(),
    };
    await writeFile(join(root, 'service.json'), JSON.stringify(state), { mode: 0o600 });
    await expect(service(root, 'stop')).rejects.toThrow();
    expect((await service(root, 'status')).state).toBe('unreachable');
    // The foreground test child has exited, so this PID is provably no longer our worker.
    await writeFile(join(root, 'service.json'), JSON.stringify({ ...state, pid: child.pid }));
    await mkdir(join(root, 'service-start.lock'));
    await writeFile(
      join(root, 'service-start.lock/owner.json'),
      JSON.stringify({ id: randomUUID(), pid: child.pid }),
    );
    const [recovered, concurrent] = await Promise.all([
      service(root, 'start', ['--port', '4797']),
      service(root, 'start', ['--port', '4797']),
    ]);
    expect(recovered.state).toBe('running');
    expect(concurrent.pid).toBe(recovered.pid);
    expect((await service(root, 'status', ['--verify-mcp'])).mcpVerified).toBe(true);
  } finally {
    await service(root, 'stop');
    await rm(root, { recursive: true, force: true });
  }
});

test('paired background startup verifies MCP without persisting the browser pairing link in logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleansave-service-pairing-'));
  try {
    await expect(
      execute(process.execPath, [cli, 'start', '--managed-service', '--data-dir', root], {
        timeout: 5000,
      }),
    ).rejects.toThrow();
    const started = await service(root, 'start', ['--port', '4797', '--require-pairing']);
    expect(started.state).toBe('running');
    expect((await fetch(started.url + '/api/v1/records')).status).toBe(401);
    expect((await service(root, 'status', ['--verify-mcp'])).mcpVerified).toBe(true);
    const log = await readFile(started.logFile, 'utf8');
    expect(log).toContain('pairing enabled');
    expect(log).not.toContain('#pair=');
    const token = (await readFile(join(root, 'credentials/agent-token.txt'), 'utf8')).trim();
    expect(log).not.toContain(token);
  } finally {
    await service(root, 'stop');
    await rm(root, { recursive: true, force: true });
  }
});
