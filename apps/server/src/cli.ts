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
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string', default: '4777' },
      dev: { type: 'boolean', default: false },
      proxy: { type: 'string' },
      'proxy-platforms': { type: 'string' },
      'browser-executable': { type: 'string' },
      'base-url': { type: 'string' },
      scopes: { type: 'string', default: 'read,write' },
      name: { type: 'string', default: 'agent' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'CleanSave: cleansave [start|mcp|token|revoke] [--data-dir PATH] [--port 4777]\nMCP connects to the running backend; token accepts --name and --scopes.\nOptional: --proxy http://127.0.0.1:PORT --proxy-platforms youtube,tiktok --browser-executable PATH\n',
    );
    return;
  }
  const command = positionals[0] ?? 'start';
  const root = resolve(values['data-dir'] ?? process.env.CLEANSAVE_DATA_DIR ?? defaultDataRoot());
  if (command === 'mcp') {
    const token =
      process.env.CLEANSAVE_TOKEN ??
      (await readFile(join(root, 'credentials', 'agent-token.txt'), 'utf8')).trim();
    await startStdio({
      baseUrl: values['base-url'] ?? process.env.CLEANSAVE_URL ?? 'http://127.0.0.1:' + values.port,
      token,
    });
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
  const port = z.coerce.number().int().min(1024).max(65535).parse(values.port);
  const packedWeb = fileURLToPath(new URL('./web', import.meta.url));
  const sourceWeb = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const proxy = values.proxy ?? process.env.CLEANSAVE_PROXY;
  const browserExecutable = values['browser-executable'] ?? process.env.CLEANSAVE_BROWSER;
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
    ...(proxy ? { network: { proxy }, proxyPlatforms } : {}),
    ...(browserExecutable ? { browserExecutable } : {}),
    ...(existsSync(packedWeb)
      ? { webRoot: packedWeb }
      : existsSync(sourceWeb)
        ? { webRoot: sourceWeb }
        : {}),
  });
  await backend.app.listen({ host: '127.0.0.1', port });
  const uiPort = values.dev ? 5173 : port;
  process.stdout.write(
    `CleanSave is running. Open this single-use pairing link:\nhttp://127.0.0.1:${uiPort}/#pair=${backend.auth.pairingSecret}\nData: ${root}\n`,
  );
  const stop = (): void => {
    void backend.app
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  void main().catch(() => {
    process.stderr.write(
      'CleanSave could not start. Check the data directory, port and running backend.\n',
    );
    process.exitCode = 1;
  });
