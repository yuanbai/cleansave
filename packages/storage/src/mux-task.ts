import { z } from 'zod';

/** Bound the owner-supplied file paths and output byte limit passed to the mux worker. */
export const muxTaskSchema = z.object({
  video: z.string().max(4096),
  audio: z.string().max(4096),
  output: z.string().max(4096),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1024 ** 3),
});

/** Validate the mux worker output receipt and nonempty audio/video packet counts. */
export const muxResultSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  videoPackets: z.number().int().positive(),
  audioPackets: z.number().int().positive(),
});
