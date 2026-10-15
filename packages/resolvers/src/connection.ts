import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { Agent, request } from 'undici';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { AppError, discardBody } from '@cleansave/core';

/** Explicit outbound routing configuration; direct networking is the default. */
export interface NetworkOptions {
  proxy?: string;
}

/** Accept public unicast IPs and reject private, mapped, multicast, and reserved addresses. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

/** Validate a credential-free loopback HTTP CONNECT proxy and return its connection endpoint. */
export function proxyEndpoint(value: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('invalid_proxy', 'Use a loopback HTTP proxy address.');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new AppError(
      'invalid_proxy',
      'Only an explicitly configured loopback HTTP CONNECT proxy without credentials is supported.',
    );
  return {
    host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 80),
  };
}
const dnsSchema = z.object({
  Status: z.number(),
  Answer: z
    .array(
      z.object({
        name: z.string(),
        type: z.number(),
        TTL: z.number().int().nonnegative(),
        data: z.string(),
      }),
    )
    .max(64)
    .optional(),
});

/** Follow matching DNS aliases and require every returned IPv4 destination to be public. */
export function publicDnsAnswers(
  value: unknown,
  hostname: string,
): { addresses: string[]; ttl: number } {
  const response = dnsSchema.parse(value);
  if (response.Status !== 0)
    throw new AppError(
      'dns_unavailable',
      'The configured secure DNS route did not resolve this source.',
      422,
      true,
    );
  const normalized = (name: string): string => name.toLowerCase().replace(/\.$/, '');
  const names = new Set([normalized(hostname)]);
  for (let hop = 0; hop < 8; hop++)
    for (const answer of response.Answer ?? [])
      if (answer.type === 5 && names.has(normalized(answer.name)))
        names.add(normalized(answer.data));
  const answers = (response.Answer ?? []).filter(
    (answer) => answer.type === 1 && names.has(normalized(answer.name)),
  );
  if (!answers.length)
    throw new AppError(
      'dns_unavailable',
      'No supported public address was returned for this source.',
      422,
      true,
    );
  if (!answers.every((answer) => isPublicAddress(answer.data)))
    throw new AppError('unsafe_url', 'Secure DNS returned a private or reserved destination.');
  return {
    addresses: [...new Set(answers.map((answer) => answer.data))],
    ttl: Math.min(300, ...answers.map((answer) => answer.TTL)),
  };
}

/**
 * Open a cancellable CONNECT tunnel through an explicit local proxy to a validated public IP on
 * port 443.
 */
export async function proxyTunnel(
  proxy: string,
  address: string,
  signal: AbortSignal,
): Promise<Socket> {
  if (!isPublicAddress(address))
    throw new AppError('unsafe_url', 'The tunnel destination is not a public address.');
  const endpoint = proxyEndpoint(proxy);
  const authority = address.includes(':') ? `[${address}]:443` : `${address}:443`;
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: endpoint.host,
      port: endpoint.port,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
    });
    const abort = (): void => {
      request.destroy(
        new AppError('network_timeout', 'The proxy connection timed out.', 422, true),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    request.once('error', () => {
      signal.removeEventListener('abort', abort);
      reject(
        new AppError(
          'proxy_unavailable',
          'The configured local proxy could not establish a connection.',
          422,
          true,
        ),
      );
    });
    request.once('connect', (response, socket, head) => {
      signal.removeEventListener('abort', abort);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(
          new AppError(
            'proxy_unavailable',
            'The configured proxy refused the public destination.',
            422,
            true,
          ),
        );
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

/** Open a cancellable TCP connection to a validated public IP on HTTPS port 443. */
export async function directTunnel(address: string, signal: AbortSignal): Promise<Socket> {
  if (!isPublicAddress(address))
    throw new AppError('unsafe_url', 'The tunnel destination is not public.');
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port: 443 });
    const abort = (): void => {
      socket.destroy(
        new AppError('network_timeout', 'The source connection timed out.', 422, true),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    socket.once('connect', () => {
      signal.removeEventListener('abort', abort);
      resolve(socket);
    });
    socket.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function encryptedTunnel(
  proxy: string,
  address: string,
  hostname: string,
  signal: AbortSignal,
): Promise<TLSSocket> {
  const tunnel = await proxyTunnel(proxy, address, signal);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      socket: tunnel,
      servername: hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    const abort = (): void => {
      socket.destroy(new AppError('network_timeout', 'The connection timed out.', 422, true));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    socket.once('error', () => {
      signal.removeEventListener('abort', abort);
      reject(
        new AppError(
          'tls_connection_failed',
          'The source could not establish a verified HTTPS connection through the configured route.',
          422,
          true,
        ),
      );
    });
    socket.once('secureConnect', () => {
      signal.removeEventListener('abort', abort);
      resolve(socket);
    });
  });
}

/**
 * Validate DNS destinations and create direct or TLS-verified proxy connections with public-IP
 * pinning.
 */
export class ConnectionPolicy {
  private readonly cache = new Map<string, { until: number; addresses: string[] }>();

  /**
   * Create this component with explicit dependencies; no work starts until its public operations
   * are called.
   */
  constructor(public readonly options: NetworkOptions = {}) {
    if (options.proxy) proxyEndpoint(options.proxy);
  }

  /**
   * Resolve only public destinations, using TLS-verified DNS-over-HTTPS when proxy mode is
   * configured.
   */
  public async addresses(hostname: string, signal: AbortSignal): Promise<string[]> {
    if (!this.options.proxy) {
      const results = await lookup(hostname, { all: true, verbatim: true });
      if (!results.length || !results.every((item) => isPublicAddress(item.address)))
        throw new AppError('unsafe_url', 'The source resolves to a private or reserved address.');
      return results.map((item) => item.address);
    }
    const cached = this.cache.get(hostname);
    if (cached && cached.until > Date.now()) return cached.addresses;
    const proxy = this.options.proxy;
    // A numeric public bootstrap avoids using the failing local DNS to reach DoH.
    const dns = new Agent({
      connect: (options, callback) => {
        if (options.hostname !== 'cloudflare-dns.com' || options.protocol !== 'https:') {
          callback(new AppError('unsafe_url', 'Invalid secure DNS destination.'), null);
          return;
        }
        void encryptedTunnel(proxy, '1.1.1.1', 'cloudflare-dns.com', signal).then(
          (socket) => callback(null, socket),
          (error) =>
            callback(error instanceof Error ? error : new Error('Connection failed'), null),
        );
      },
    });
    try {
      const response = await request(
        'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
        {
          dispatcher: dns,
          headers: { accept: 'application/dns-json' },
          signal,
          headersTimeout: 10000,
          bodyTimeout: 10000,
        },
      );
      if (response.statusCode !== 200) {
        discardBody(response.body);
        throw new AppError(
          'dns_unavailable',
          'Secure DNS did not return a successful response.',
          422,
          true,
        );
      }
      let raw = '';
      for await (const chunk of response.body) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) {
          discardBody(response.body);
          throw new AppError('dns_unavailable', 'The secure DNS response exceeded its limit.', 422);
        }
      }
      const parsed = publicDnsAnswers(JSON.parse(raw), hostname);
      if (this.cache.size >= 512) this.cache.clear();
      this.cache.set(hostname, {
        until: Date.now() + parsed.ttl * 1000,
        addresses: parsed.addresses,
      });
      return parsed.addresses;
    } finally {
      await dns.close();
    }
  }

  /** Create an owned HTTP dispatcher that validates DNS destinations before connecting. */
  public dispatcher(): Agent {
    if (!this.options.proxy)
      return new Agent({
        connect: {
          lookup: (hostname, options, callback) => {
            void this.addresses(hostname, AbortSignal.timeout(15000)).then(
              (addresses) => {
                const first = addresses[0];
                if (!first) {
                  callback(
                    new AppError('dns_unavailable', 'No source address was returned.'),
                    [],
                    4,
                  );
                  return;
                }
                const list = addresses.map((address) => ({
                  address,
                  family: address.includes(':') ? 6 : 4,
                }));
                if (options.all) callback(null, list);
                else callback(null, first, first.includes(':') ? 6 : 4);
              },
              (error) => callback(error instanceof Error ? error : new Error('DNS failed'), [], 4),
            );
          },
        },
      });
    const proxy = this.options.proxy;
    return new Agent({
      connect: (options, callback) => {
        if (options.protocol !== 'https:' || (options.port && options.port !== '443')) {
          callback(
            new AppError('unsafe_url', 'Only HTTPS source connections are supported.'),
            null,
          );
          return;
        }
        const signal = AbortSignal.timeout(15000);
        void this.addresses(options.hostname, signal)
          .then(async (addresses) => {
            const address = addresses[0];
            if (!address) throw new AppError('dns_unavailable', 'No source address was returned.');
            return encryptedTunnel(proxy, address, options.hostname, signal);
          })
          .then(
            (socket) => callback(null, socket),
            (error) =>
              callback(error instanceof Error ? error : new Error('Connection failed'), null),
          );
      },
    });
  }
}
