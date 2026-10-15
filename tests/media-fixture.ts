import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Output,
  Mp4OutputFormat,
  FilePathTarget,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacket,
} from 'mediabunny';
const packet = z.object({
  base64: z.string(),
  type: z.enum(['key', 'delta']),
  timestamp: z.number(),
  duration: z.number().nonnegative(),
});
const fixtureSchema = z.object({
  video: z.object({
    config: z.object({
      codec: z.string(),
      codedWidth: z.number(),
      codedHeight: z.number(),
      description: z.array(z.number()),
    }),
    packets: z.array(packet),
  }),
  audio: z.object({
    config: z.object({
      codec: z.string(),
      sampleRate: z.number(),
      numberOfChannels: z.number(),
      description: z.array(z.number()),
    }),
    packets: z.array(packet),
  }),
});
/** Encoded red frames and silent AAC, with no real platform content. */
export async function mediaFixture(
  root: string,
): Promise<{ video: Buffer; audio: Buffer; videoPath: string; audioPath: string }> {
  const fixture = fixtureSchema.parse(
    JSON.parse(await readFile(new URL('./fixtures/av-packets.json', import.meta.url), 'utf8')),
  );
  const videoPath = join(root, 'synthetic-video.mp4'),
    audioPath = join(root, 'synthetic-audio.m4a');
  const videoOutput = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new FilePathTarget(videoPath),
  });
  const vs = new EncodedVideoPacketSource('avc');
  videoOutput.addVideoTrack(vs);
  await videoOutput.start();
  for (const packet of fixture.video.packets)
    await vs.add(
      new EncodedPacket(
        new Uint8Array(Buffer.from(packet.base64, 'base64')),
        packet.type,
        packet.timestamp,
        packet.duration,
      ),
      {
        decoderConfig: {
          ...fixture.video.config,
          description: new Uint8Array(fixture.video.config.description),
        },
      },
    );
  await videoOutput.finalize();
  const audioOutput = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new FilePathTarget(audioPath),
  });
  const as = new EncodedAudioPacketSource('aac');
  audioOutput.addAudioTrack(as);
  await audioOutput.start();
  for (const packet of fixture.audio.packets)
    await as.add(
      new EncodedPacket(
        new Uint8Array(Buffer.from(packet.base64, 'base64')),
        packet.type,
        packet.timestamp,
        packet.duration,
      ),
      {
        decoderConfig: {
          ...fixture.audio.config,
          description: new Uint8Array(fixture.audio.config.description),
        },
      },
    );
  await audioOutput.finalize();
  return {
    video: await readFile(videoPath),
    audio: await readFile(audioPath),
    videoPath,
    audioPath,
  };
}
