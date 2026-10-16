import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { createBackend } from '../apps/server/src/server.js';
import { Auth } from '../apps/server/src/auth.js';
import { fixtureBackend } from './helpers.js';

const instances: Awaited<ReturnType<typeof fixtureBackend>>[] = [];
const local = { host: '127.0.0.1:4777' };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of instances.splice(0)) {
    await backend.app.close();
    await rm(backend.root, { recursive: true, force: true });
  }
});

async function fixture(...args: Parameters<typeof fixtureBackend>) {
  const backend = await fixtureBackend(...args);
  instances.push(backend);
  return backend;
}

it('allows local reads, writes, media access and removal without pairing or credentials by default', async () => {
  const b = await fixture();
  expect(b.auth.requirePairing).toBe(false);
  expect(b.auth.pairingSecret).toBeNull();
  const saved = await b.app.inject({
    method: 'POST',
    url: '/api/v1/records',
    headers: local,
    payload: { input: 'https://www.douyin.com/video/12345', downloadContent: true },
  });
  expect(saved.statusCode).toBe(202);
  await b.settled();
  const id = saved.json<{ recordId: string }>().recordId;
  const record = await b.repo.get(id);
  const asset = record.assets[0];
  if (!asset) throw new Error('Missing synthetic media');
  for (const url of [
    '/api/v1/settings',
    '/api/v1/records',
    `/api/v1/records/${id}`,
    `/api/v1/assets/${asset.id}?localPath=true`,
    `/api/v1/assets/${asset.id}/content`,
  ]) {
    const result = await b.app.inject({ url, headers: local });
    expect(result.statusCode).toBe(200);
    expect(result.headers['set-cookie']).toBeUndefined();
  }
  expect(
    (await b.app.inject({ method: 'DELETE', url: `/api/v1/records/${id}`, headers: local }))
      .statusCode,
  ).toBe(202);
  await b.settled();
  expect((await b.app.inject({ url: `/api/v1/records/${id}`, headers: local })).statusCode).toBe(
    404,
  );
});

it('keeps default local access working with stale cookies and after a backend restart', async () => {
  const b = await fixture();
  const read = () =>
    b.app.inject({
      url: '/api/v1/records',
      headers: { ...local, cookie: 'cleansave_session=expired' },
    });
  expect((await read()).statusCode).toBe(200);
  await b.save();
  await b.settled();
  await b.app.close();
  const restarted = await createBackend({ root: b.root });
  try {
    const result = await restarted.app.inject({ url: '/api/v1/records', headers: local });
    expect(result.statusCode).toBe(200);
    expect(result.json().items).toHaveLength(1);
    expect(restarted.auth.pairingSecret).toBeNull();
  } finally {
    await restarted.app.close();
  }
});

it('rejects non-loopback peers even with a forged Host, forwarded address, or valid token', async () => {
  const b = await fixture();
  for (const remoteAddress of [
    '192.168.1.8',
    '203.0.113.5',
    '0.0.0.0',
    '::',
    '2001:db8::1',
    '::ffff:192.168.1.8',
  ]) {
    for (const url of ['/health', '/api/v1/records', '/mcp']) {
      const result = await b.app.inject({
        url,
        remoteAddress,
        headers: { ...b.headers, 'x-forwarded-for': '127.0.0.1' },
      });
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('local_access_only');
    }
  }
  for (const remoteAddress of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
    expect(
      (await b.app.inject({ url: '/api/v1/records', headers: local, remoteAddress })).statusCode,
    ).toBe(200);
});

it('retains Host and Origin checks when pairing is disabled', async () => {
  const b = await fixture();
  const badHost = await b.app.inject({
    url: '/api/v1/records',
    headers: { host: 'evil.example:4777' },
  });
  expect(badHost.statusCode).toBe(403);
  expect(badHost.json().error.code).toBe('invalid_host');
  for (const method of ['GET', 'POST'] as const) {
    const result = await b.app.inject({
      method,
      url: '/api/v1/records',
      headers: { ...local, origin: 'https://evil.example' },
      ...(method === 'POST' ? { payload: { input: 'https://www.douyin.com/video/12345' } } : {}),
    });
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe('invalid_origin');
  }
});

it('does not issue pairing sessions unless pairing is enabled', async () => {
  const b = await fixture();
  const result = await b.app.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: { ...local, origin: 'http://127.0.0.1:4777' },
    payload: { secret: 'unused-old-link' },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().error.code).toBe('pairing_disabled');
  expect(result.headers['set-cookie']).toBeUndefined();
});

it('keeps supplied tokens scoped and rejects invalid or revoked credentials in local mode', async () => {
  const b = await fixture();
  const readOnly = await b.auth.mint('read-only', ['read']);
  expect(
    (
      await b.app.inject({
        url: '/api/v1/records',
        headers: { ...local, authorization: 'Bearer ' + readOnly },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await b.app.inject({
        method: 'POST',
        url: '/api/v1/records',
        headers: { ...local, authorization: 'Bearer ' + readOnly },
        payload: { input: 'https://www.douyin.com/video/12345' },
      })
    ).statusCode,
  ).toBe(403);
  await b.auth.revoke('read-only');
  for (const authorization of ['Bearer invalid', 'Bearer ' + readOnly, 'Basic invalid']) {
    expect(
      (await b.app.inject({ url: '/api/v1/records', headers: { ...local, authorization } }))
        .statusCode,
    ).toBe(401);
  }
});

it('requires pairing when opted in, rejects token fallback, and invalidates sessions on restart', async () => {
  const b = await fixture(undefined, { requirePairing: true });
  expect(b.auth.pairingSecret).toEqual(expect.any(String));
  expect((await b.app.inject({ url: '/api/v1/records', headers: local })).statusCode).toBe(401);
  const paired = await b.app.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: { ...local, origin: 'http://127.0.0.1:4777' },
    payload: { secret: b.auth.pairingSecret },
  });
  expect(paired.statusCode).toBe(200);
  const cookie = paired.cookies[0]?.name + '=' + paired.cookies[0]?.value;
  expect(
    (await b.app.inject({ url: '/api/v1/records', headers: { ...local, cookie } })).statusCode,
  ).toBe(200);
  expect(
    (
      await b.app.inject({
        url: '/api/v1/records',
        headers: { ...local, cookie, authorization: 'Bearer invalid' },
      })
    ).statusCode,
  ).toBe(401);
  await b.app.close();
  const restarted = await createBackend({ root: b.root, requirePairing: true });
  try {
    expect(
      (await restarted.app.inject({ url: '/api/v1/records', headers: { ...local, cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await restarted.app.inject({ url: '/api/v1/records', headers: b.headers })).statusCode,
    ).toBe(200);
  } finally {
    await restarted.app.close();
  }
});

it('retains the five-minute expiry for optional unused pairing links', async () => {
  const b = await fixture();
  const auth = new Auth(b.root, true);
  const secret = auth.pairingSecret;
  if (!secret) throw new Error('Missing optional pairing secret');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1);
  expect(() => auth.pair(secret)).toThrow('fresh browser pairing link');
});
