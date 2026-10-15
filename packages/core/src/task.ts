import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { AppError } from './index.js';

const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string().max(80) }),
]);

/** A hard deadline and termination also bound synchronous parser/mux work. */
export async function isolatedTask<T>(
  entry: URL,
  input: unknown,
  output: z.ZodType<T>,
  signal: AbortSignal,
  timeoutMs: number,
  heapMb: 128 | 256 = 128,
): Promise<T> {
  signal.throwIfAborted();
  const worker = new Worker(entry, {
    workerData: input,
    resourceLimits: { maxOldGenerationSizeMb: heapMb, stackSizeMb: 4 },
    stdout: true,
    stderr: true,
    execArgv: [],
  });
  // Neither upstream diagnostics nor guest output may leak through worker streams.
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void =>
        reject(new AppError('cancelled', 'The operation was cancelled.', 409));
      const timer = setTimeout(
        () =>
          reject(
            new AppError(
              'worker_limit',
              'The isolated operation exceeded its execution limit.',
              422,
            ),
          ),
        timeoutMs,
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      worker.once('message', (raw: unknown) => {
        cleanup();
        const reply = replySchema.safeParse(raw);
        if (!reply.success || !reply.data.ok) {
          reject(
            new AppError(
              'worker_failed',
              'The isolated operation could not process this source.',
              422,
            ),
          );
          return;
        }
        const parsed = output.safeParse(reply.data.value);
        if (parsed.success) resolve(parsed.data);
        else reject(new AppError('invalid_worker_result', 'The isolated result was invalid.', 422));
      });
      worker.once('error', () => {
        cleanup();
        reject(new AppError('worker_failed', 'The isolated operation could not finish.', 422));
      });
      worker.once('exit', () => {
        cleanup();
        reject(
          new AppError('worker_failed', 'The isolated operation stopped before completion.', 422),
        );
      });
    });
  } finally {
    await worker.terminate();
  }
}
