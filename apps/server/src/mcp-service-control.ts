import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '@cleansave/core';
import { serviceStatusSchema, type ServiceStatusDto } from '@cleansave/contracts';
import type { ServiceControl } from '@cleansave/mcp';
import { Auth, type Scope } from './auth.js';
import {
  restartService,
  serviceStatus,
  ServiceError,
  stopService,
  type ServiceStatus,
} from './service.js';

function publicStatus(current: ServiceStatus, url: URL, unmanaged = false): ServiceStatusDto {
  return serviceStatusSchema.parse({
    state: unmanaged ? 'unmanaged' : current.state,
    managed: !unmanaged && Boolean(current.url),
    url: url.origin,
    ...(current.pid === undefined ? {} : { pid: current.pid }),
    ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt }),
  });
}

async function hasForegroundOwner(root: string): Promise<boolean> {
  const pid = Number(await readFile(join(root, 'owner.lock'), 'utf8').catch(() => '0'));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * Bind stdio lifecycle controls to one local library and URL. Token permissions are checked from
 * private credential storage on every call, including while stopped, without initializing SQLite
 * or minting credentials. Only explicit lifecycle tools may launch a managed backend.
 */
export function createServiceControl(options: {
  root: string;
  baseUrl: string;
  token: string;
}): ServiceControl {
  const auth = new Auth(options.root);
  const endpoint = (): URL => {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !url.port ||
      Number(url.port) < 1024
    )
      throw new ServiceError('Service controls require the local background service URL.');
    return url;
  };
  const status = async (): Promise<ServiceStatusDto> => {
    const url = endpoint();
    const current = await serviceStatus(options.root);
    if (current.url && new URL(current.url).port !== url.port)
      throw new ServiceError(
        'The managed service port does not match this MCP connection. Check its base URL and library.',
      );
    const unmanaged = current.state === 'stopped' && (await hasForegroundOwner(options.root));
    return publicStatus(current, url, unmanaged);
  };
  const guarded = async (
    scope: Scope,
    run: () => Promise<ServiceStatusDto>,
  ): Promise<ServiceStatusDto> => {
    try {
      const scopes = await auth.authorize('Bearer ' + options.token, undefined);
      if (!scopes.includes(scope))
        throw new AppError('scope_required', `This operation requires ${scope} access.`, 403);
      return await run();
    } catch (error) {
      throw new Error(
        error instanceof ServiceError || error instanceof AppError
          ? error.message
          : 'The local service operation failed. Check its configuration and private log.',
        { cause: error },
      );
    }
  };
  const change = (action: 'start' | 'stop' | 'restart'): Promise<ServiceStatusDto> =>
    guarded('write', async () => {
      const current = await status();
      if (!current.managed)
        throw new ServiceError(
          'Start this library once with service start before using managed service controls. Foreground servers cannot be stopped here.',
        );
      const url = endpoint();
      const port = Number(url.port);
      const completed =
        action === 'stop'
          ? await stopService(options.root, port)
          : await restartService(options.root, action === 'restart', port);
      return publicStatus(completed, url);
    });
  return {
    status: () => guarded('read', status),
    start: () => change('start'),
    stop: () => change('stop'),
    restart: () => change('restart'),
  };
}
