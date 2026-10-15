import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { z } from 'zod';
import { youtubeTaskSchema } from './youtube-task.js';

async function evaluate(code: string): Promise<unknown> {
  if (Buffer.byteLength(code) > 1024 * 1024) throw new Error('Script limit');
  const engine = await getQuickJS();
  return engine.evalCode(code, {
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 256 * 1024,
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 500),
  });
}
try {
  const task = youtubeTaskSchema.parse(workerData);
  let value: unknown;
  if (task.kind === 'evaluate') value = await evaluate(task.code);
  else {
    const { Player, Misc, Platform, Log } = await import('youtubei.js');
    Log.setLevel(Log.Level.NONE);
    Platform.shim.eval = async (data) =>
      z
        .object({
          n: z
            .string()
            .min(1)
            .max(8192)
            .refine((value) => !value.startsWith('enhanced_except_'))
            .optional(),
          sig: z.string().min(1).max(8192).optional(),
        })
        .parse(await evaluate('(function(){\n' + data.output + '\n})()'));
    Platform.shim.fetch = async () => {
      throw new Error('Worker networking disabled');
    };
    const script = task.player;
    const player = script
      ? await Player.create(
          undefined,
          async (input) => {
            const url = new URL(
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
            );
            if (
              url.origin !== 'https://www.youtube.com' ||
              url.pathname !== `/s/player/${script.id}/player_es6.vflset/en_US/base.js`
            )
              throw new Error('Unapproved preloaded script');
            return new Response(script.source);
          },
          undefined,
          script.id,
        )
      : undefined;
    const urls = [];
    for (const format of task.formats) {
      const parsed = new Misc.Format(format);
      const url = await parsed.decipher(player);
      urls.push({ itag: format.itag, url });
    }
    value = urls;
  }
  if ((JSON.stringify(value)?.length ?? 0) > (task.kind === 'evaluate' ? 65536 : 2 * 1024 * 1024))
    throw new Error('Result limit');
  parentPort?.postMessage({ ok: true, value });
} catch {
  parentPort?.postMessage({ ok: false, code: 'youtube_transform_failed' });
} finally {
  parentPort?.close();
}
