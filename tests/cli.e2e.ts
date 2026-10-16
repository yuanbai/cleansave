import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of [
  { name: 'default local access', args: [], environment: null, paired: false },
  { name: 'explicit pairing flag', args: ['--require-pairing'], environment: '0', paired: true },
  { name: 'pairing environment opt-in', args: [], environment: '1', paired: true },
  { name: 'disabled pairing environment', args: [], environment: 'false', paired: false },
]) {
  test('packaged CLI: ' + mode.name, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleansave-cli-access-'));
    const env = { ...process.env };
    delete env.CLEANSAVE_REQUIRE_PAIRING;
    if (mode.environment !== null) env.CLEANSAVE_REQUIRE_PAIRING = mode.environment;
    const child = spawn(
      process.execPath,
      ['dist/cli.js', '--data-dir', root, '--port', '4796', ...mode.args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    try {
      await expect
        .poll(() => output.includes('CleanSave is running.') || child.exitCode !== null)
        .toBe(true);
      expect(child.exitCode).toBeNull();
      const url = 'http://127.0.0.1:4796';
      const records = await fetch(url + '/api/v1/records');
      expect(records.status).toBe(mode.paired ? 401 : 200);
      if (mode.paired) {
        const secret = /#pair=([A-Za-z0-9_-]+)/.exec(output)?.[1];
        if (!secret) throw new Error('Optional pairing link was not printed');
        const pair = () =>
          fetch(url + '/api/v1/session', {
            method: 'POST',
            headers: { origin: url, 'content-type': 'application/json' },
            body: JSON.stringify({ secret }),
          });
        const paired = await pair();
        expect(paired.status).toBe(200);
        const cookie = paired.headers.get('set-cookie')?.split(';')[0];
        if (!cookie) throw new Error('Pairing did not issue a cookie');
        expect((await fetch(url + '/api/v1/records', { headers: { cookie } })).status).toBe(200);
        expect((await pair()).status).toBe(401);
      } else {
        expect(output).not.toContain('#pair=');
        expect(await records.json()).toEqual({ items: [], nextCursor: null });
      }
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
