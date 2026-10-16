import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';

const stateSchema = z.object({
  id: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
  controlPort: z.number().int().min(1).max(65535).nullable(),
  port: z.number().int().min(1024).max(65535),
  cli: z.string(),
  node: z.string(),
  startedAt: z.iso.datetime(),
});
type State = z.infer<typeof stateSchema>;
const controlRequest = z.object({
  id: z.uuid(),
  pid: z.number().int().positive(),
  token: z.string().max(64),
  command: z.enum(['status', 'stop']),
});
const controlReply = z.object({ id: z.uuid(), pid: z.number().int(), stopping: z.boolean() });

/** Safe, actionable service-management errors; unexpected errors remain redacted by the CLI. */
export class ServiceError extends Error {}

/** Absolute stdio command for the same installation, library, and backend; contains no token. */
export interface McpCommand {
  command: string;
  args: string[];
}

/** Public service status. Private control credentials are never returned. */
export interface ServiceStatus {
  state: 'running' | 'stopping' | 'starting' | 'unreachable' | 'stopped';
  dataDirectory: string;
  logFile: string;
  url?: string;
  pid?: number;
  startedAt?: string;
  mcp?: McpCommand;
  mcpVerified?: boolean;
}

/** Launch options; ordinary backend arguments are passed unchanged to the owned child. */
export interface ServiceOptions {
  root: string;
  port: number;
  cli: string;
  args: string[];
}

function statePath(root: string): string {
  return join(root, 'service.json');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function readState(root: string): Promise<State | null> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(statePath(root), 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new ServiceError('Cannot read service state. Check the private service.json file.');
  }
}

async function writeState(root: string, state: State, exclusive = false): Promise<void> {
  const temporary = join(root, `service-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
    } finally {
      await file.close();
    }
    if (exclusive) await link(temporary, statePath(root));
    else await rename(temporary, statePath(root));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeState(root: string, id: string): Promise<void> {
  if ((await readState(root))?.id === id) await rm(statePath(root), { force: true });
}

function requestControl(
  state: State,
  command: 'status' | 'stop',
): Promise<z.infer<typeof controlReply>> {
  return new Promise((resolveReply, reject) => {
    if (state.controlPort === null) {
      reject(new Error('Service is starting.'));
      return;
    }
    const socket = connect({ host: '127.0.0.1', port: state.controlPort });
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(1500, () => socket.destroy(new Error('Control request timed out.')));
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({ id: state.id, pid: state.pid, token: state.token, command }) + '\n',
      ),
    );
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.length > 1024) socket.destroy(new Error('Invalid control reply.'));
      if (!received.includes('\n')) return;
      try {
        const reply = controlReply.parse(JSON.parse(received));
        if (reply.id !== state.id || reply.pid !== state.pid) throw new Error('Wrong service.');
        resolveReply(reply);
        socket.destroy();
      } catch {
        socket.destroy(new Error('Invalid control reply.'));
      }
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Control connection closed.')));
  });
}

async function canonicalRoot(root: string, create = false): Promise<string> {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    return await realpath(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return resolve(root);
    throw error;
  }
}

async function reserveStart(root: string): Promise<() => Promise<void>> {
  const directory = join(root, 'service-start.lock');
  const ownerPath = join(directory, 'owner.json');
  const ownerSchema = z.object({ id: z.uuid(), pid: z.number().int().positive() });
  const owner = { id: randomUUID(), pid: process.pid };
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        const file = await open(ownerPath, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(owner));
        } finally {
          await file.close();
        }
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return () => rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const previous = await readFile(ownerPath, 'utf8')
      .then((value) => ownerSchema.parse(JSON.parse(value)))
      .catch(() => null);
    if (previous && !alive(previous.pid)) {
      // Elect one reaper. Recheck identity after election so an old observation cannot delete
      // a fresh reservation. Unreadable/unfinished reservations are never guessed away.
      try {
        await mkdir(join(directory, 'reap'));
        const current = ownerSchema.parse(JSON.parse(await readFile(ownerPath, 'utf8')));
        if (current.id === previous.id && !alive(current.pid))
          await rm(directory, { recursive: true, force: true });
      } catch {
        /* Another starter is recovering the reservation. */
      }
    }
    await delay(100);
  }
  throw new ServiceError(
    'Another service start is pending. Inspect service-start.lock before retrying.',
  );
}

/**
 * Inspect only a managed service, verifying its private control identity instead of trusting a PID
 * or a public health response. Does not start a backend or alter the library.
 */
export async function serviceStatus(root: string): Promise<ServiceStatus> {
  root = await canonicalRoot(root);
  const status: ServiceStatus = {
    state: 'stopped',
    dataDirectory: root,
    logFile: join(root, 'service.log'),
  };
  const state = await readState(root);
  if (!state) return status;
  status.url = `http://127.0.0.1:${state.port}`;
  status.pid = state.pid;
  status.startedAt = state.startedAt;
  status.mcp = {
    command: state.node,
    args: [state.cli, 'mcp', '--base-url', status.url, '--data-dir', root],
  };
  if (!alive(state.pid)) return status;
  try {
    const reply = await requestControl(state, 'status');
    status.state = reply.stopping ? 'stopping' : 'running';
  } catch {
    status.state = state.controlPort === null ? 'starting' : 'unreachable';
  }
  return status;
}

/**
 * Start one detached backend and wait for its control identity and HTTP health. Repeated starts
 * reuse that service. Never adopt, signal, or stop an unrelated foreground server or reused PID.
 * No login items, scheduled tasks, system services, or reboot startup are installed.
 */
export async function startService(options: ServiceOptions): Promise<ServiceStatus> {
  const root = await canonicalRoot(options.root, true);
  const release = await reserveStart(root);
  try {
    return await startReservedService({ ...options, root });
  } finally {
    await release();
  }
}

async function startReservedService(options: ServiceOptions): Promise<ServiceStatus> {
  const root = options.root;
  const existing = await readState(root);
  if (existing && !alive(existing.pid)) await removeState(root, existing.id);
  const state: State = {
    id: randomUUID(),
    token: randomBytes(32).toString('hex'),
    pid: process.pid,
    controlPort: null,
    port: options.port,
    cli: await realpath(resolve(options.cli)),
    node: process.execPath,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeState(root, state, true);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    for (let attempt = 0; attempt < 80; attempt++) {
      const status = await serviceStatus(root);
      if (status?.state === 'running') {
        if (status.url !== `http://127.0.0.1:${options.port}`)
          throw new ServiceError('This library is running on another port. Use service status.');
        return status;
      }
      if (status?.state === 'stopped' || status?.state === 'unreachable') break;
      await delay(100);
    }
    throw new ServiceError(
      'The service is starting or unreachable. Inspect service status and its private log.',
    );
  }
  let child: ReturnType<typeof spawn> | undefined;
  let failed = false;
  try {
    const log = await open(
      join(root, 'service.log'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await log.chmod(0o600);
      child = spawn(
        state.node,
        [
          state.cli,
          'start',
          '--data-dir',
          root,
          '--port',
          String(options.port),
          '--managed-service',
          ...options.args,
        ],
        { detached: true, cwd: root, stdio: ['ignore', log.fd, log.fd, 'ipc'] },
      );
      child.once('error', () => {
        failed = true;
      });
    } finally {
      await log.close();
    }
    const launched = child;
    if (!launched.pid) throw new Error('Could not launch service.');
    state.pid = launched.pid;
    await writeState(root, state);
    launched.send({ id: state.id }, () => {});
    for (let attempt = 0; attempt < 150; attempt++) {
      if (failed || launched.exitCode !== null || launched.signalCode !== null) break;
      const status = await serviceStatus(root);
      if (status.state === 'running') {
        const response = await fetch(status.url + '/health', {
          signal: AbortSignal.timeout(1500),
          redirect: 'error',
        });
        if (
          response.ok &&
          z.object({ status: z.literal('ok') }).safeParse(await response.json()).success
        ) {
          if (launched.connected) launched.disconnect();
          launched.unref();
          return status;
        }
      }
      await delay(100);
    }
    throw new Error('Service did not become ready.');
  } catch {
    // This handle was created here; no PID read from disk is ever signalled.
    if (child?.connected) child.disconnect();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (
        let attempt = 0;
        attempt < 50 && child.exitCode === null && child.signalCode === null;
        attempt++
      )
        await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await removeState(root, state.id);
    throw new ServiceError(
      'Service could not start. Check service.log, the port, and whether another backend owns this library.',
    );
  }
}

/**
 * Gracefully stop the backend that proves the saved control identity. Stale or forged PID files
 * never authorize a signal. Unresponsive services are reported for manual inspection.
 */
export async function stopService(root: string): Promise<ServiceStatus> {
  root = await canonicalRoot(root);
  const state = await readState(root);
  if (!state) return serviceStatus(root);
  if (!alive(state.pid)) {
    await removeState(root, state.id);
    return serviceStatus(root);
  }
  try {
    await requestControl(state, 'stop');
  } catch {
    throw new ServiceError(
      'Cannot verify the managed backend. No process was stopped. Inspect service status and service.log.',
    );
  }
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!(await readState(root))) return serviceStatus(root);
    await delay(100);
  }
  throw new ServiceError(
    'Shutdown is still in progress. Inspect service status before starting again.',
  );
}

/**
 * Read-only verification through the published stdio command, including real capability and library
 * calls. Does not claim that a separate agent session has reloaded its MCP configuration.
 */
export async function verifyServiceMcp(status: ServiceStatus): Promise<ServiceStatus> {
  if (status.state !== 'running' || !status.mcp)
    throw new ServiceError('Start the managed service before verifying MCP.');
  const client = new Client({ name: 'cleansave-setup-check', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ ...status.mcp, stderr: 'pipe' }), {
      timeout: 5000,
    });
    for (const name of ['get_capabilities', 'list_records']) {
      const result = await client.callTool(
        {
          name,
          arguments: name === 'list_records' ? { limit: 1 } : {},
        },
        { timeout: 5000 },
      );
      if (result.isError) throw new Error('MCP tool failed.');
    }
    return { ...status, mcpVerified: true };
  } catch {
    throw new ServiceError(
      'The service is running, but its stdio MCP check failed. Check the matching library, token, and URL.',
    );
  } finally {
    await client.close();
  }
}

/**
 * Receive a launcher's IPC handshake before opening SQLite. A detached child whose launcher dies
 * before completing its ownership reservation exits without creating an orphan backend.
 */
export async function managedLaunch(root: string): Promise<State> {
  if (!process.send || !process.connected)
    throw new ServiceError('Use service start to launch a managed backend.');
  const message = await new Promise<unknown>((resolveMessage, reject) => {
    const timeout = setTimeout(() => finish(new Error('Launcher timed out.')), 10000);
    const disconnected = (): void => finish(new Error('Launcher disconnected.'));
    const received = (value: unknown): void => finish(null, value);
    const finish = (error: Error | null, value?: unknown): void => {
      clearTimeout(timeout);
      process.off('message', received);
      process.off('disconnect', disconnected);
      if (error) reject(error);
      else resolveMessage(value);
    };
    process.once('message', received);
    process.once('disconnect', disconnected);
  });
  const state = await readState(root);
  if (
    !state ||
    state.pid !== process.pid ||
    state.id !== z.object({ id: z.uuid() }).parse(message).id
  )
    throw new ServiceError('The managed launch reservation does not match.');
  return state;
}

/**
 * Open a bounded, token-authenticated loopback control channel after the HTTP backend is ready.
 * The channel is separate from REST/MCP and never accepts browser or public network requests.
 * The returned disposer removes only this instance's state after the backend has closed.
 */
export async function serveControl(
  root: string,
  state: State,
  stop: () => void,
): Promise<() => Promise<void>> {
  let stopping = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(1500, () => socket.destroy());
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes('\n')) return;
      try {
        const request = controlRequest.parse(JSON.parse(input));
        if (request.id !== state.id || request.pid !== process.pid) {
          socket.destroy();
          return;
        }
        const token = Buffer.from(request.token);
        if (
          token.length !== state.token.length ||
          !timingSafeEqual(token, Buffer.from(state.token))
        ) {
          socket.destroy();
          return;
        }
        const shouldStop = request.command === 'stop' && !stopping;
        if (shouldStop) stopping = true;
        socket.end(JSON.stringify({ id: state.id, pid: process.pid, stopping }) + '\n');
        if (shouldStop) setImmediate(stop);
      } catch {
        socket.destroy();
      }
    });
  });
  server.maxConnections = 8;
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListening();
    });
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing control address.');
    if ((await readState(root))?.id !== state.id) throw new Error('Service ownership changed.');
    await writeState(root, { ...state, controlPort: address.port });
  } catch (error) {
    server.close();
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClosed, reject) =>
      server.close((error) => (error ? reject(error) : resolveClosed())),
    );
    await removeState(root, state.id);
  };
}
