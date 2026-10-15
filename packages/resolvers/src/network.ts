import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { request } from 'undici';
import { ConnectionPolicy, type NetworkOptions } from './connection.js';
export { isPublicAddress } from './connection.js';
import { CookieJar } from 'tough-cookie';
import { setTimeout as delay } from 'node:timers/promises';
import type { Dispatcher } from 'undici';
import { AppError, discardBody, type AccessSource, type HttpResult } from '@cleansave/core';
import { approvedUrl } from './input.js';

/** Anonymous mobile user agent used for public share-page and image requests. */
export const mobileAgent =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1';

/** Anonymous desktop user agent used for playback metadata and compatible video requests. */
export const desktopAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

/** A bounded decoded page and its validated redirect chain. */
export interface Page {
  text: string;
  url: string;
  redirects: string[];
}

/** A disposable anonymous page session with scoped cookies and controlled network access. */
export interface PageSession {
  /** Fetch and decode a public page with redirect validation and a 6 MiB decoded-body limit. */
  page(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Page>;

  /**
   * Send a bounded resolver payload to an approved public endpoint; POST redirects are rejected.
   */
  post(
    url: string,
    body: unknown,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<Page>;

  /**
   * Serialize anonymous cookies for transient same-origin media access; never persist this value
   * publicly.
   */
  cookieSnapshot(): string;

  /** Set a validated visitor-cookie name scoped to the supplied HTTPS host. */
  setCookie(name: string, value: string, host: string): void;

  /** Release resources owned by this instance; callers must not reuse it afterward. */
  close(): Promise<void>;
}

/**
 * Fetch approved public pages with scoped cookies, bounded retries, redirect validation, and size
 * limits.
 */
export class NetworkSession implements PageSession {
  private readonly jar: CookieJar;
  private readonly agent: Dispatcher;

  /**
   * Create this component with explicit dependencies; no work starts until its public operations
   * are called.
   */
  constructor(
    public userAgent = mobileAgent,
    cookies?: string,
    private readonly transport?: Dispatcher,
    network: NetworkOptions = {},
  ) {
    this.agent = new ConnectionPolicy(network).dispatcher();
    this.jar = cookies ? CookieJar.deserializeSync(cookies) : new CookieJar();
  }

  /**
   * Serialize anonymous cookies for transient same-origin media access; never persist this value
   * publicly.
   */
  public cookieSnapshot(): string {
    return JSON.stringify(this.jar.serializeSync());
  }

  /** Set a validated visitor-cookie name scoped to the supplied HTTPS host. */
  public setCookie(name: string, value: string, host: string): void {
    if (/^[\w-]{1,64}$/.test(name))
      this.jar.setCookieSync(`${name}=${value}; Path=/; Secure`, 'https://' + host);
  }

  /** Release resources owned by this instance; callers must not reuse it afterward. */
  public async close(): Promise<void> {
    await this.agent.close();
    await this.transport?.close();
  }

  private async send(
    url: URL,
    options: Omit<NonNullable<Parameters<typeof request>[1]>, 'signal'> & { signal: AbortSignal },
  ): Promise<Awaited<ReturnType<typeof request>>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request(url, options);
        if (attempt >= 2 || (response.statusCode !== 429 && response.statusCode < 500))
          return response;
        discardBody(response.body);
        const retryAfter = response.headers['retry-after'];
        const header = typeof retryAfter === 'string' ? retryAfter : '';
        const requested = /^\d+$/.test(header)
          ? Number(header) * 1000
          : Math.max(0, Date.parse(header) - Date.now());
        await delay(
          Math.min(
            10000,
            Number.isFinite(requested) ? requested : 300 * 2 ** attempt + Math.random() * 150,
          ),
          undefined,
          { signal: options.signal },
        );
      } catch (error) {
        const retryable =
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          [
            'ECONNRESET',
            'ETIMEDOUT',
            'EAI_AGAIN',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_SOCKET',
          ].includes(String(error.code));
        if (attempt >= 2 || !retryable || options.signal?.aborted) throw error;
        await delay(300 * 2 ** attempt + Math.random() * 150, undefined, {
          signal: options.signal,
        });
      }
    }
  }

  /** Open a validated page or media stream through at most eight redirects; callers own body disposal. */
  public async get(
    value: string,
    media: boolean,
    signal: AbortSignal,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<HttpResult & { redirects: string[] }> {
    let url = approvedUrl(value, media);
    const redirects = [url.toString()];
    for (let hop = 0; hop <= 8; hop++) {
      signal.throwIfAborted();
      const cookie = this.jar.getCookieStringSync(url.toString());
      const response = await this.send(url, {
        dispatcher: this.transport ?? this.agent,
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          'user-agent': this.userAgent,
          'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          'accept-encoding': 'identity',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
          ...(cookie ? { cookie } : {}),
        },
        signal,
        headersTimeout: 15000,
        bodyTimeout: 15000,
      });
      const cookies = response.headers['set-cookie'];
      for (const entry of typeof cookies === 'string' ? [cookies] : (cookies ?? [])) {
        try {
          this.jar.setCookieSync(entry, url.toString());
        } catch {
          /* Reject invalid or cross-domain cookies. */
        }
      }
      const normalized: Record<string, string> = {};
      for (const [key, entry] of Object.entries(response.headers))
        if (entry !== undefined) normalized[key] = Array.isArray(entry) ? entry.join(', ') : entry;
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        discardBody(response.body);
        if (body !== undefined || !normalized.location || hop === 8)
          throw new AppError(
            'post_unavailable',
            'The source redirected too many times or refused the request.',
            422,
          );
        const next = approvedUrl(new URL(normalized.location, url).toString(), media);
        if (next.origin !== url.origin)
          headers = Object.fromEntries(
            Object.entries(headers).filter(([name]) =>
              ['range', 'if-range'].includes(name.toLowerCase()),
            ),
          );
        url = next;
        redirects.push(url.toString());
        continue;
      }
      return {
        body: response.body,
        headers: normalized,
        status: response.statusCode,
        url: url.toString(),
        redirects,
      };
    }
    throw new AppError('post_unavailable', 'The source did not return content.', 422);
  }

  private async read(result: Awaited<ReturnType<NetworkSession['get']>>): Promise<Page> {
    if (result.status < 200 || result.status >= 300) {
      discardBody(result.body);
      throw new AppError(
        result.status === 429 ? 'rate_limited' : 'platform_temporarily_blocked',
        'The platform refused public access. Open the original link to check access.',
        422,
        result.status >= 500 || result.status === 429,
      );
    }
    const encoding = result.headers['content-encoding'];
    const stream =
      encoding === 'gzip'
        ? result.body.pipe(createGunzip())
        : encoding === 'br'
          ? result.body.pipe(createBrotliDecompress())
          : encoding === 'deflate'
            ? result.body.pipe(createInflate())
            : result.body;
    const chunks: Buffer[] = [];
    const forwardError = (error: Error): void => {
      if (stream !== result.body) stream.destroy(error);
    };
    result.body.on('error', forwardError);
    let length = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 6 * 1024 * 1024)
          throw new AppError('upstream_too_large', 'The source page is too large.', 422);
        chunks.push(bytes);
      }
    } finally {
      result.body.off('error', forwardError);
      if (stream !== result.body) stream.destroy();
      discardBody(result.body);
    }
    return {
      text: Buffer.concat(chunks).toString('utf8'),
      url: result.url,
      redirects: result.redirects,
    };
  }

  /** Fetch and decode a public page with redirect validation and a 6 MiB decoded-body limit. */
  public async page(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Page> {
    return this.read(await this.get(url, false, signal, headers));
  }

  /**
   * Send a bounded resolver payload to an approved public endpoint; POST redirects are rejected.
   */
  public async post(
    url: string,
    body: unknown,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Page> {
    return this.read(await this.get(url, false, signal, headers, body));
  }
}

/**
 * Open a controlled media stream with transient source credentials; dispose its session when the
 * body closes.
 */
export async function openMedia(
  url: string,
  source: AccessSource,
  signal: AbortSignal,
  network: NetworkOptions = {},
): Promise<HttpResult> {
  const session = new NetworkSession(source.userAgent, source.cookies, undefined, network);
  try {
    const result = await session.get(url, true, signal, {
      referer: source.referer,
      range: 'bytes=0-',
    });
    result.body.once('close', () => {
      void session.close().catch(() => {});
    });
    return result;
  } catch (error) {
    await session.close();
    throw error;
  }
}
