import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError } from '@cleansave/core';
import { fixtureBackend, capture } from './helpers.js';
const calls = new Map<string, number>();
const backend = await fixtureBackend(
  {
    resolve: async (url) => {
      const postId = /\/(\d+)\/?(?:\?|$)/.exec(url)?.[1] ?? '12345';
      const n = (calls.get(postId) ?? 0) + 1;
      calls.set(postId, n);
      if (postId === '999' && n > 1)
        throw new AppError('network_unavailable', 'Fixture refresh unavailable.', 422);
      return capture({
        id: postId,
        title: n > 1 ? 'Updated fixture landscape' : 'Fixture landscape',
        counts: {
          likes: { kind: 'exact', value: String(100 + n * 10) },
          comments: n % 2 ? null : { kind: 'exact', value: '4' },
        },
      });
    },
  },
  { port: 4788, webRoot: resolve('dist/web') },
);
backend.app.addHook('onError', async (request, _reply, error) => {
  if (request.url === '/health') process.stderr.write('Fixture health: ' + error.message + '\n');
});
await backend.app.listen({ host: '127.0.0.1', port: 4788 });
await writeFile(
  '.test-runtime.json',
  JSON.stringify({
    root: backend.root,
    pairingSecret: backend.auth.pairingSecret,
    token: backend.token,
  }),
  { mode: 0o600 },
);
const stop = (): void => {
  void backend.app
    .close()
    .then(() => rm(backend.root, { recursive: true, force: true }))
    .then(() => rm('.test-runtime.json', { force: true }))
    .catch(() => {
      process.exitCode = 1;
    });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
