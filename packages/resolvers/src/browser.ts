import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { CookieJar } from 'tough-cookie';
import { AppError, type Capture } from '@cleansave/core';
import {
  ConnectionPolicy,
  isPublicAddress,
  proxyTunnel,
  directTunnel,
  type NetworkOptions,
} from './connection.js';
import { approvedUrl, hostMatches, postIds } from './input.js';
import { assignment, parseJson, visitorChallenge } from './parsing.js';
import { parseDouyin } from './platforms.js';
import { desktopAgent } from './network.js';

const browserAssetDomains = [
  'byted-static.com',
  'ibytedapm.com',
  'bytegoofy.com',
  'douyinstatic.com',
  'lf-c-flwb.bytetos.com',
  'lf-developer-cdn.open-douyin.com',
];

/**
 * Validate HTTPS destinations used by the isolated public-player browser and its enforcing gateway.
 */
export function browserTarget(value: string): URL {
  try {
    return approvedUrl(value, true);
  } catch {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !hostMatches(url.hostname, browserAssetDomains)
    )
      throw new AppError('unsafe_url', 'The browser destination is not approved.');
    return url;
  }
}

/** Allow only bounded public-player bootstrap requests and required platform scripts/styles. */
export function browserRequestAllowed(
  value: string,
  method: string,
  kind: string,
  bodyBytes = 0,
): boolean {
  const url = browserTarget(value);
  const platform = hostMatches(url.hostname, ['douyin.com', 'iesdouyin.com']);
  const bootstrap =
    url.hostname === 'open.douyin.com' && url.pathname === '/api/douyin/v1/open/auth/embed_video/';
  if (method === 'POST')
    return bootstrap && ['fetch', 'xhr'].includes(kind) && bodyBytes >= 0 && bodyBytes <= 16384;
  if (!['GET', 'HEAD'].includes(method)) return false;
  if (kind === 'document') return platform;
  if (kind === 'script' || kind === 'stylesheet')
    return (
      (platform || hostMatches(url.hostname, browserAssetDomains)) &&
      /\.(?:js|css)$/.test(url.pathname)
    );
  if (kind === 'fetch' || kind === 'xhr')
    return (
      platform &&
      (bootstrap ||
        /^\/aweme\/v1\/web\/aweme\/detail\/?$/.test(url.pathname) ||
        /^\/web\/api\/v2\/aweme\/(?:iteminfo|slidesinfo)\/?$/.test(url.pathname))
    );
  return false;
}

/**
 * Start a temporary loopback CONNECT gateway that pins approved browser hosts to validated public
 * IPs.
 */
export async function createBrowserGateway(
  network: NetworkOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const policy = new ConnectionPolicy(network);
  const sockets = new Set<Duplex>();
  const closing = new AbortController();
  const server: Server = createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  server.maxConnections = 64;
  server.headersTimeout = 10000;
  server.on('connect', (request, client, head) => {
    sockets.add(client);
    client.on('error', () => {
      client.destroy();
    });
    client.once('close', () => sockets.delete(client));
    void (async () => {
      const target = browserTarget('https://' + request.url);
      if (head.length > 16384) throw new AppError('unsafe_url', 'Unexpected tunnel payload.');
      const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(15000)]);
      const addresses = await policy.addresses(target.hostname, signal);
      const address = addresses[0];
      if (!address || !isPublicAddress(address))
        throw new AppError('unsafe_url', 'Invalid browser destination.');
      const remote = network.proxy
        ? await proxyTunnel(network.proxy, address, signal)
        : await directTunnel(address, signal);
      sockets.add(remote);
      remote.once('close', () => sockets.delete(remote));
      remote.on('error', () => client.destroy());
      client.once('close', () => remote.destroy());
      if (client.destroyed) {
        remote.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    })().catch(() => {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new AppError(
      'browser_unavailable',
      'The controlled browser gateway could not start.',
      503,
    );
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      closing.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
let browserQueue: Promise<void> = Promise.resolve();

/** Recover Douyin metadata in a fresh Chromium context behind an enforcing connection gateway. */
export class PublicBrowser {
  /**
   * Create this component with explicit dependencies; no work starts until its public operations
   * are called.
   */
  constructor(
    private readonly executablePath: string,
    private readonly network: NetworkOptions = {},
  ) {}

  /** Serialize isolated public-player recovery and require the requested Douyin post identity. */
  public async douyin(id: string, signal: AbortSignal, pageUrl?: string): Promise<Capture | null> {
    const previous = browserQueue;
    let release: () => void = () => {};
    browserQueue = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      signal.throwIfAborted();
      return await this.capture(id, signal, pageUrl);
    } finally {
      release();
    }
  }

  private async capture(
    id: string,
    caller: AbortSignal,
    pageUrl?: string,
  ): Promise<Capture | null> {
    const { chromium } = await import('playwright-core');
    const gateway = await createBrowserGateway(this.network);
    const signal = AbortSignal.any([caller, AbortSignal.timeout(20000)]);
    const browser = await chromium
      .launch({
        executablePath: this.executablePath,
        chromiumSandbox: true,
        proxy: { server: gateway.url },
        args: ['--proxy-bypass-list=<-loopback>', '--disable-quic'],
        timeout: 15000,
      })
      .catch(async () => {
        await gateway.close();
        throw new AppError(
          'browser_unavailable',
          'The configured isolated browser could not start.',
          503,
        );
      });
    const abort = (): void => {
      void browser.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    let capture: Capture | null = null;
    const pending = new Set<Promise<void>>();
    try {
      const userAgent = desktopAgent.replace(/Chrome\/[\d.]+/, 'Chrome/' + browser.version());
      const context = await browser.newContext({ userAgent, serviceWorkers: 'block' });
      await context.route('**/*', async (route) => {
        const request = route.request();
        try {
          if (
            !browserRequestAllowed(
              request.url(),
              request.method(),
              request.resourceType(),
              request.postDataBuffer()?.length ?? 0,
            )
          ) {
            await route.abort();
            return;
          }
          await route.continue();
        } catch {
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (
          url.hostname !== 'www.douyin.com' ||
          !url.pathname.includes('/aweme/detail/') ||
          url.searchParams.get('aweme_id') !== id ||
          response.status() !== 200
        )
          return;
        const task = (async () => {
          if (Number(response.headers()['content-length'] ?? '0') > 6 * 1024 * 1024) return;
          const body = await response.body();
          if (body.length > 6 * 1024 * 1024) return;
          const parsed = parseDouyin(
            parseJson(body.toString('utf8')),
            id,
            `https://www.douyin.com/video/${id}`,
          );
          if (parsed) capture = parsed;
        })().catch(() => {
          /* A bounded response candidate may be invalid or cancelled. */
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
      await page.goto(pageUrl ?? `https://open.douyin.com/player/video?vid=${id}&autoplay=0`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      let reloaded = false;
      while (!capture && !signal.aborted) {
        const url = page.url();
        const actual = postIds('douyin', new URL(url));
        if (actual.length && !actual.includes(id))
          throw new AppError('source_changed', 'The public player changed post identity.', 409);
        const html = await page.content();
        if (html.length <= 6 * 1024 * 1024) {
          const rendered = parseDouyin(
            assignment(html, 'window._ROUTER_DATA'),
            id,
            `https://www.douyin.com/video/${id}`,
          );
          if (rendered) capture = rendered;
          const cookies: {
            name: string;
            value: string;
            domain: string;
            path: string;
            secure: boolean;
          }[] = [];
          const solved = visitorChallenge(html, url, {
            setCookie: (name, value, host) => {
              cookies.push({ name, value, domain: host, path: '/', secure: true });
            },
          });
          if (solved && !reloaded) {
            reloaded = true;
            await context.addCookies(cookies);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
          }
        }
        if (!capture) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await Promise.allSettled([...pending]);
      if (!capture) return null;
      const jar = new CookieJar();
      for (const cookie of await context.cookies()) {
        const domain = cookie.domain.replace(/^\./, '');
        try {
          jar.setCookieSync(
            `${cookie.name}=${cookie.value}; Path=${cookie.path}${cookie.secure ? '; Secure' : ''}`,
            `https://${domain}/`,
          );
        } catch {
          /* Only valid scoped anonymous cookies are retained in memory. */
        }
      }
      const result: Capture = capture;
      return {
        ...result,
        metadata: { ...result.metadata, adapterVersion: 'douyin/0.1.0+public-player' },
        sources: result.sources.map((source) => ({
          ...source,
          userAgent,
          cookies: JSON.stringify(jar.serializeSync()),
        })),
      };
    } catch (error) {
      if (signal.aborted && !caller.aborted) return null;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      await browser.close();
      await gateway.close();
    }
  }
}
