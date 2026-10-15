import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  Input,
  FilePathSource,
  FilePathTarget,
  ALL_FORMATS,
  Output,
  Mp4OutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  type InputTrack,
} from 'mediabunny';
import { muxTaskSchema } from './mux-task.js';

const open = (path: string): Input =>
  new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(path, { maxCacheSize: 1024 * 1024 }),
  });

async function digest(
  track: InputTrack,
): Promise<{ hash: string; count: number; start: number; end: number }> {
  const hash = createHash('sha256');
  let count = 0,
    start = Infinity,
    end = -Infinity;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (++count > 500000) throw new Error('Packet limit');
    hash.update(packet.data);
    start = Math.min(start, packet.timestamp);
    end = Math.max(end, packet.timestamp + packet.duration);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 21600)
      throw new Error('Duration limit');
  }
  if (!count) throw new Error('Missing packets');
  return { hash: hash.digest('hex'), count, start, end };
}
let output: Output | null = null;
const inputs: Input[] = [];
try {
  const task = muxTaskSchema.parse(workerData);
  const videoInput = open(task.video),
    audioInput = open(task.audio);
  inputs.push(videoInput, audioInput);
  const videos = await videoInput.getVideoTracks(),
    audios = await audioInput.getAudioTracks();
  if (
    videos.length !== 1 ||
    audios.length !== 1 ||
    (await videoInput.getAudioTracks()).length ||
    (await audioInput.getVideoTracks()).length
  )
    throw new Error('Unexpected tracks');
  const video = videos[0],
    audio = audios[0];
  if (!video || !audio || (await video.getCodec()) !== 'avc' || (await audio.getCodec()) !== 'aac')
    throw new Error('Unsupported codecs');
  const beforeVideo = await digest(video),
    beforeAudio = await digest(audio);
  if (
    Math.abs(beforeVideo.start - beforeAudio.start) > 1 ||
    Math.abs(beforeVideo.end - beforeAudio.end) > 2
  )
    throw new Error('Track timing mismatch');
  const vconfig = await video.getDecoderConfig(),
    aconfig = await audio.getDecoderConfig();
  if (!vconfig || !aconfig) throw new Error('Missing codec configuration');
  const vsource = new EncodedVideoPacketSource('avc'),
    asource = new EncodedAudioPacketSource('aac');
  output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new FilePathTarget(task.output, { chunkSize: 1024 * 1024 }),
  });
  output.addVideoTrack(vsource);
  output.addAudioTrack(asource);
  await output.start();
  const vi = new EncodedPacketSink(video).packets(),
    ai = new EncodedPacketSink(audio).packets();
  let vp = await vi.next(),
    ap = await ai.next(),
    bytes = 0;
  try {
    while (!vp.done || !ap.done) {
      if (!vp.done && (ap.done || vp.value.timestamp <= ap.value.timestamp)) {
        bytes += vp.value.data.byteLength;
        await vsource.add(vp.value, { decoderConfig: vconfig });
        vp = await vi.next();
      } else if (!ap.done) {
        bytes += ap.value.data.byteLength;
        await asource.add(ap.value, { decoderConfig: aconfig });
        ap = await ai.next();
      }
      if (bytes > task.maxBytes) throw new Error('Byte limit');
    }
  } finally {
    await vi.return();
    await ai.return();
  }
  await output.finalize();
  const size = (await stat(task.output)).size;
  if (size > task.maxBytes) throw new Error('Output byte limit');
  const check = open(task.output);
  inputs.push(check);
  const v = await check.getPrimaryVideoTrack(),
    a = await check.getPrimaryAudioTrack();
  if (!v || !a) throw new Error('Incomplete output');
  for (const [before, after] of [
    [beforeVideo, await digest(v)],
    [beforeAudio, await digest(a)],
  ]) {
    if (
      !before ||
      !after ||
      before.hash !== after.hash ||
      before.count !== after.count ||
      Math.abs(before.start - after.start) > 0.00001 ||
      Math.abs(before.end - after.end) > 0.00001
    )
      throw new Error('Output packet mismatch');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(task.output)) hash.update(chunk);
  parentPort?.postMessage({
    ok: true,
    value: {
      bytes: size,
      sha256: hash.digest('hex'),
      videoPackets: beforeVideo.count,
      audioPackets: beforeAudio.count,
    },
  });
} catch {
  parentPort?.postMessage({ ok: false, code: 'mux_failed' });
} finally {
  if (output && output.state !== 'finalized') await output.cancel();
  for (const input of inputs) input.dispose();
  parentPort?.close();
}
