#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startStdio } from '@cleansave/mcp';
import { z } from 'zod';
import { platformSchema } from '@cleansave/contracts';
import { createBackend } from './server.js';
import { Auth, scopeSchema } from './auth.js';
import {
  ServiceError,
  managedLaunch,
  restartService,
  serveControl,
  serviceStatus,
  startService,
  stopService,
  verifyServiceMcp,
} from './service.js';
import { createServiceControl } from './mcp-service-control.js';

function pairingEnabled(value: boolean | undefined): boolean {
  return (
    value ??
    z
      .enum(['0', '1', 'false', 'true'])
      .default('false')
      .transform((setting) => setting === '1' || setting === 'true')
      .parse(process.env.CLEANSAVE_REQUIRE_PAIRING)
  );
}

/** Choose the platform-specific per-user data directory, honoring XDG_DATA_HOME or LOCALAPPDATA. */
export function defaultDataRoot(): string {
  const home = homedir();
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'CleanSave')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'CleanSave')
      : join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'cleansave');
}

/** Run the CLI command selected by process arguments; stdio MCP connects to an existing backend. */
export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string', default: '4777' },
      dev: { type: 'boolean', default: false },
      'require-pairing': { type: 'boolean' },
      proxy: { type: 'string' },
      'proxy-platforms': { type: 'string' },
      'browser-executable': { type: 'string' },
      'base-url': { type: 'string' },
      scopes: { type: 'string', default: 'read,write' },
      name: { type: 'string', default: 'agent' },
      help: { type: 'boolean' },
      'verify-mcp': { type: 'boolean' },
      'managed-service': { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'CleanSave: cleansave [start|mcp|token|revoke] [--data-dir PATH] [--port 4777]\nBackground: cleansave service [start|status|stop|restart] [--data-dir PATH] [--port 4777]\nService commands return JSON. Restart reuses saved settings; status --verify-mcp checks MCP.\nBackground startup does not install login or reboot autostart.\nLocalhost access needs no pairing by default. Enable it with --require-pairing or CLEANSAVE_REQUIRE_PAIRING=1.\nMCP connects to the backend and supports explicit managed service lifecycle tools; token accepts --name and --scopes.\nOptional: --proxy http://127.0.0.1:PORT --proxy-platforms youtube,tiktok --browser-executable PATH\n',
    );
    return;
  }
  const command = positionals[0] ?? 'start';
  const root = resolve(values['data-dir'] ?? process.env.CLEANSAVE_DATA_DIR ?? defaultDataRoot());
  if (command === 'service') {
    const action = positionals[1];
    let status;
    if (action === 'start') {
      if (values.dev || values['managed-service'])
        throw new ServiceError('Service startup uses the production build. Run pnpm build first.');
      const args = [
        pairingEnabled(values['require-pairing']) ? '--require-pairing' : '--no-require-pairing',
      ];
      for (const [key, variable] of [
        ['proxy', 'CLEANSAVE_PROXY'],
        ['proxy-platforms', 'CLEANSAVE_PROXY_PLATFORMS'],
        ['browser-executable', 'CLEANSAVE_BROWSER'],
      ] as const) {
        const value = values[key] ?? process.env[variable];
        if (value !== undefined) args.push('--' + key, value);
      }
      status = await startService({
        root,
        port: z.coerce.number().int().min(1024).max(65535).parse(values.port),
        cli: fileURLToPath(import.meta.url),
        args,
      });
    } else if (action === 'status') status = await serviceStatus(root);
    else if (action === 'stop') status = await stopService(root);
    else if (action === 'restart') status = await restartService(root);
    else throw new ServiceError('Use cleansave service start, status, stop, or restart.');
    if (values['verify-mcp']) status = await verifyServiceMcp(status);
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return;
  }
  if (command === 'mcp') {
    const token =
      process.env.CLEANSAVE_TOKEN ??
      (await readFile(join(root, 'credentials', 'agent-token.txt'), 'utf8')).trim();
    const baseUrl =
      values['base-url'] ?? process.env.CLEANSAVE_URL ?? 'http://127.0.0.1:' + values.port;
    await startStdio({ baseUrl, token, control: createServiceControl({ root, baseUrl, token }) });
    return;
  }
  if (command === 'token' || command === 'revoke') {
    const auth = new Auth(root);
    await auth.initialize();
    if (command === 'revoke') await auth.revoke(values.name);
    else
      process.stdout.write(
        (await auth.mint(
          values.name,
          z.array(scopeSchema).min(1).parse(values.scopes.split(',')),
        )) + '\n',
      );
    return;
  }
  if (command !== 'start') throw new Error('Unknown command. Run cleansave --help.');
  const managed = values['managed-service'] ? await managedLaunch(root) : null;
  const port = z.coerce.number().int().min(1024).max(65535).parse(values.port);
  const packedWeb = fileURLToPath(new URL('./web', import.meta.url));
  const sourceWeb = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const proxy = values.proxy ?? process.env.CLEANSAVE_PROXY;
  const browserExecutable = values['browser-executable'] ?? process.env.CLEANSAVE_BROWSER;
  const requirePairing = pairingEnabled(values['require-pairing']);
  const proxyPlatforms = z
    .array(platformSchema)
    .parse(
      (values['proxy-platforms'] ?? process.env.CLEANSAVE_PROXY_PLATFORMS ?? 'youtube,tiktok')
        .split(',')
        .map((value) => value.trim()),
    );
  const backend = await createBackend({
    root,
    port,
    dev: values.dev,
    requirePairing,
    ...(proxy ? { network: { proxy }, proxyPlatforms } : {}),
    ...(browserExecutable ? { browserExecutable } : {}),
    ...(existsSync(packedWeb)
      ? { webRoot: packedWeb }
      : existsSync(sourceWeb)
        ? { webRoot: sourceWeb }
        : {}),
  });
  try {
    await backend.app.listen({ host: '127.0.0.1', port });
  } catch (error) {
    await backend.app.close();
    throw error;
  }
  const uiPort = values.dev ? 5173 : port;
  const url = `http://127.0.0.1:${uiPort}/`;
  process.stdout.write(
    backend.auth.pairingSecret && !managed
      ? `CleanSave is running. Open this single-use pairing link:\n${url}#pair=${backend.auth.pairingSecret}\nData: ${root}\n`
      : `CleanSave is running. Open:\n${url}\nLocalhost access: pairing ${backend.auth.requirePairing ? 'enabled' : 'disabled'}.\nData: ${root}\n`,
  );
  let disposeControl: (() => Promise<void>) | undefined;
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    void backend.app
      .close()
      .then(async () => {
        await disposeControl?.();
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (managed) {
    try {
      disposeControl = await serveControl(root, managed, stop);
    } catch (error) {
      await backend.app.close();
      throw error;
    }
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  void main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof ServiceError
        ? error.message
        : 'CleanSave could not start. Check the data directory, port and running backend.') + '\n',
    );
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  });
