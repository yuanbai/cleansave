import { z } from 'zod';

/** Allowlist bounded static-format fields accepted by the isolated YouTube transform worker. */
export const youtubeFormatSchema = z.object({
  itag: z.number().int().positive(),
  mimeType: z.string().max(256),
  contentLength: z.string().regex(/^\d+$/),
  lastModified: z.string().regex(/^\d+$/),
  url: z.string().max(32768).optional(),
  signatureCipher: z.string().max(32768).optional(),
  cipher: z.string().max(32768).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bitrate: z.number().nonnegative().default(0),
  audioTrack: z
    .object({
      id: z.string().max(128),
      displayName: z.string().max(256).optional(),
      audioIsDefault: z.boolean().optional(),
    })
    .optional(),
});

/** A static YouTube format with pinned itag, byte length, and modification identity. */
export type YoutubeFormat = z.infer<typeof youtubeFormatSchema>;

/** Validate owner-supplied transform input before starting isolated evaluation. */
export const youtubeTaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evaluate'), code: z.string().max(1024 * 1024) }),
  z.object({
    kind: z.literal('formats'),
    formats: z.array(youtubeFormatSchema).max(64),
    player: z
      .object({ id: z.string().regex(/^[\w-]{1,80}$/), source: z.string().max(6 * 1024 * 1024) })
      .optional(),
  }),
]);

/** Validate the bounded itag-to-URL results returned from the transform worker. */
export const youtubeUrlsSchema = z
  .array(z.object({ itag: z.number().int().positive(), url: z.string().max(32768) }))
  .max(64);
