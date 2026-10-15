import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '@cleansave/core';

/**
 * Independent token permissions for reads, writes, deletion, and local filesystem path disclosure.
 */
export const scopeSchema = z.enum(['read', 'write', 'delete', 'local_path']);

/** A backend permission checked equally for REST and MCP operations. */
export type Scope = z.infer<typeof scopeSchema>;
const tokensSchema = z.array(
  z.object({ name: z.string(), hash: z.string(), scopes: z.array(scopeSchema) }),
);
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Manage hashed API tokens and process-local browser sessions with one-use, five-minute pairing.
 */
export class Auth {
  /** One-use secret for pairing a local browser within five minutes of construction. */
  public readonly pairingSecret = randomBytes(24).toString('base64url');
  private readonly expiresAt = Date.now() + 5 * 60 * 1000;
  private paired = false;
  private readonly sessions = new Map<string, number>();

  /**
   * Use the library data root for private credential files; pairing state belongs to this process
   * only.
   */
  constructor(private readonly root: string) {}

  /**
   * Create private credential storage and mint the default read/write token only for a new library.
   */
  public async initialize(): Promise<void> {
    await mkdir(join(this.root, 'credentials'), { recursive: true, mode: 0o700 });
    try {
      tokensSchema.parse(
        JSON.parse(await readFile(join(this.root, 'credentials', 'access.json'), 'utf8')),
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        await this.mint('local-agent', ['read', 'write'], true);
      else throw error;
    }
  }

  /**
   * Persist a hashed named token and return its secret once; initial mint also writes the default
   * agent token file.
   */
  public async mint(name: string, scopes: Scope[], initial = false): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    let entries: z.infer<typeof tokensSchema> = [];
    if (!initial)
      entries = tokensSchema.parse(
        JSON.parse(await readFile(join(this.root, 'credentials', 'access.json'), 'utf8')),
      );
    entries.push({ name, hash: digest(token), scopes });
    const stage = join(this.root, 'credentials', randomBytes(12).toString('hex') + '.tmp');
    await writeFile(stage, JSON.stringify(entries), { mode: 0o600 });
    await rename(stage, join(this.root, 'credentials', 'access.json'));
    if (initial)
      await writeFile(join(this.root, 'credentials', 'agent-token.txt'), token, { mode: 0o600 });
    return token;
  }

  /** Exchange the unexpired, one-use pairing secret for a process-local browser session. */
  public pair(secret: string): string {
    if (
      this.paired ||
      Date.now() > this.expiresAt ||
      !timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(digest(this.pairingSecret)))
    )
      throw new AppError(
        'pairing_expired',
        'Restart the local service for a fresh browser pairing link.',
        401,
      );
    this.paired = true;
    const session = randomBytes(32).toString('base64url');
    this.sessions.set(session, Date.now() + 24 * 60 * 60 * 1000);
    return session;
  }

  /**
   * Resolve a valid bearer token or unexpired browser session into granted scopes; otherwise throw
   * unauthorized.
   */
  public async authorize(
    bearer: string | undefined,
    session: string | undefined,
  ): Promise<Scope[]> {
    if (bearer?.startsWith('Bearer ')) {
      const tokenHash = digest(bearer.slice(7));
      const entries = tokensSchema.parse(
        JSON.parse(await readFile(join(this.root, 'credentials', 'access.json'), 'utf8')),
      );
      const entry = entries.find((value) => value.hash === tokenHash);
      if (entry) return entry.scopes;
    }
    if (session && (this.sessions.get(session) ?? 0) > Date.now())
      return ['read', 'write', 'delete', 'local_path'];
    throw new AppError('unauthorized', 'Pair this browser or provide a local API token.', 401);
  }

  /**
   * Atomically remove every token with the specified name; existing browser sessions are
   * independent.
   */
  public async revoke(name: string): Promise<void> {
    const path = join(this.root, 'credentials', 'access.json');
    const entries = tokensSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const stage = path + '.tmp';
    await writeFile(stage, JSON.stringify(entries.filter((entry) => entry.name !== name)), {
      mode: 0o600,
    });
    await rename(stage, path);
  }
}
