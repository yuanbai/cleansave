import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { z } from 'zod';
const metadata = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .parse(JSON.parse(await readFile('package.json', 'utf8')));
await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    cli: 'apps/server/src/cli.ts',
    client: 'packages/client/src/index.ts',
    contracts: 'packages/contracts/src/index.ts',
    'youtube-worker': 'packages/resolvers/src/youtube-worker.ts',
    'mux-worker': 'packages/storage/src/mux-worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(metadata.dependencies),
});
await rm('dist/web', { recursive: true, force: true });
await cp('apps/web/dist', 'dist/web', { recursive: true });
await writeFile('dist/build.json', JSON.stringify({ version: '0.1.0', node: 24 }));

await rm('integrations/plugin/skills', { recursive: true, force: true });
await cp('integrations/skills', 'integrations/plugin/skills', { recursive: true });
await cp('packages/contracts/dist/index.d.ts', 'dist/contracts.d.ts');
const clientTypes = await readFile('packages/client/dist/index.d.ts', 'utf8');
await writeFile(
  'dist/client.d.ts',
  clientTypes.replaceAll('@cleansave/contracts', './contracts.js'),
);

// Preserve notices for the frontend bundle and selected runtime dependencies.
await mkdir('dist/notices', { recursive: true });
for (const name of [
  'react',
  'react-dom',
  'react-router-dom',
  '@tanstack/react-query',
  'lucide-react',
  'youtubei.js',
  'quickjs-emscripten',
  'mediabunny',
]) {
  const folder = 'node_modules/' + name;
  const notice = await readFile(folder + '/LICENSE', 'utf8').catch(() =>
    readFile(folder + '/LICENSE.md', 'utf8'),
  );
  await writeFile('dist/notices/' + name.replaceAll('/', '-') + '.txt', notice);
}
await writeFile(
  'dist/notices/mediabunny-source.txt',
  'Mediabunny 1.61.4, MPL-2.0. Unmodified dependency source is included in the installed npm package (src/), also available from https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.4.tgz . CleanSave application source is MIT.\n',
);
