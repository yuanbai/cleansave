import { afterEach, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Auth } from '../apps/server/src/auth.js';
import { createServiceControl } from '../apps/server/src/mcp-service-control.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cleansave-service-auth-'));
  roots.push(root);
  const auth = new Auth(root);
  await auth.initialize();
  const token = await auth.mint('reader', ['read']);
  return { root, auth, token };
}

it('enforces token scopes and revocation while the backend is stopped without minting credentials', async () => {
  const { root, auth, token } = await fixture();
  const control = createServiceControl({ root, token, baseUrl: 'http://127.0.0.1:4888' });
  expect(await control.status()).toEqual({
    state: 'stopped',
    managed: false,
    url: 'http://127.0.0.1:4888',
  });
  for (const action of [control.start, control.stop, control.restart])
    await expect(action()).rejects.toThrow('requires write access');
  await auth.revoke('reader');
  for (const action of [control.status, control.start, control.stop, control.restart])
    await expect(action()).rejects.toThrow('invalid or revoked');
  await expect(access(join(root, 'library.sqlite'))).rejects.toThrow();
  await expect(access(join(root, 'service.json'))).rejects.toThrow();
});

it('refuses a remote URL or a mismatched library port and never falls back from invalid credentials', async () => {
  const { root, auth } = await fixture();
  const token = await auth.mint('writer', ['read', 'write']);
  await writeFile(
    join(root, 'service-config.json'),
    JSON.stringify({
      node: process.execPath,
      cli: resolve('dist/cli.js'),
      port: 4889,
      args: ['--require-pairing'],
    }),
    { mode: 0o600 },
  );
  for (const baseUrl of [
    'https://example.com',
    'http://127.0.0.1:4888/path',
    'http://localhost:4888',
  ]) {
    const control = createServiceControl({ root, token, baseUrl });
    await expect(control.status()).rejects.toThrow(/local background service URL|does not match/);
    await expect(control.restart()).rejects.toThrow(/local background service URL|does not match/);
  }
  const invalid = createServiceControl({
    root,
    token: 'invalid-test-token',
    baseUrl: 'http://127.0.0.1:4889',
  });
  await expect(invalid.stop()).rejects.toThrow('invalid or revoked');
  const valid = createServiceControl({ root, token, baseUrl: 'http://localhost:4889/' });
  const status = await valid.status();
  expect(status).toEqual({ state: 'stopped', managed: true, url: 'http://localhost:4889' });
  expect(JSON.stringify(status)).not.toContain(root);
  await expect(access(join(root, 'service.json'))).rejects.toThrow();
});

it('redacts missing credential paths without initializing a new library', async () => {
  const { root } = await fixture();
  const missing = join(root, 'missing-library');
  const control = createServiceControl({
    root: missing,
    token: 'synthetic-token',
    baseUrl: 'http://127.0.0.1:4888',
  });
  await expect(control.status()).rejects.toThrow('local service operation failed');
  await expect(control.status()).rejects.not.toThrow(missing);
  await expect(access(missing)).rejects.toThrow();
});

it('identifies foreground ownership and refuses to adopt or stop it', async () => {
  const { root, auth } = await fixture();
  const token = await auth.mint('writer', ['read', 'write']);
  await writeFile(join(root, 'owner.lock'), String(process.pid));
  const control = createServiceControl({ root, token, baseUrl: 'http://127.0.0.1:4888' });
  expect(await control.status()).toEqual({
    state: 'unmanaged',
    managed: false,
    url: 'http://127.0.0.1:4888',
  });
  for (const operation of [control.start, control.stop, control.restart])
    await expect(operation()).rejects.toThrow('Foreground servers cannot be stopped');
});
