import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { platformSchema, type RecordDto } from '@cleansave/contracts';
import { createBackend } from '../apps/server/src/server.js';

if (process.env.CLEANSAVE_LIVE !== '1' || !process.env.CLEANSAVE_LIVE_URL)
  throw new Error(
    'Opt in with CLEANSAVE_LIVE=1 and CLEANSAVE_LIVE_URL. No default network requests.',
  );
const proxy = process.env.CLEANSAVE_PROXY;
const browserExecutable = process.env.CLEANSAVE_BROWSER;
const downloadContent = process.env.CLEANSAVE_LIVE_DOWNLOAD === '1';
const timeout = z.coerce
  .number()
  .int()
  .min(1000)
  .max(600000)
  .parse(process.env.CLEANSAVE_LIVE_TIMEOUT_MS ?? '180000');
const backend = await createBackend({
  root: resolve(process.env.CLEANSAVE_LIVE_DATA_DIR ?? '.local-data/live-tests'),
  ...(proxy
    ? {
        network: { proxy },
        proxyPlatforms: z
          .array(platformSchema)
          .parse(
            (process.env.CLEANSAVE_PROXY_PLATFORMS ?? 'youtube,tiktok')
              .split(',')
              .map((value) => value.trim()),
          ),
      }
    : {}),
  ...(browserExecutable ? { browserExecutable } : {}),
});
try {
  const service = backend.service(['read', 'write', 'local_path']);
  const accepted = await service.create({
    input: process.env.CLEANSAVE_LIVE_URL,
    downloadContent,
    requireNoWatermark: process.env.CLEANSAVE_LIVE_REQUIRE_CLEAN === '1',
  });
  let record = await service.getRecord(accepted.recordId);
  if (record.resolutionState === 'failed' && !record.activeJobIds.length) {
    await backend.repo.enqueue(record.id, 'resolve');
    backend.worker.kick();
  }
  const deadline = Date.now() + timeout;
  const pending = (value: RecordDto): boolean =>
    value.mergedIntoId !== null ||
    value.activeJobIds.length > 0 ||
    ['queued', 'resolving'].includes(value.resolutionState) ||
    (downloadContent && ['queued', 'downloading'].includes(value.downloadState));
  do {
    record = await service.getRecord(record.mergedIntoId ?? record.id);
    if (!pending(record)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  const receipts = [];
  for (const asset of record.assets.filter((asset) => asset.state === 'complete')) {
    const descriptor = await service.getMedia(asset.id, true);
    if (!descriptor.localPath) throw new Error('Owned local receipt path was unavailable.');
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(descriptor.localPath)) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    receipts.push({
      mime: asset.mime,
      bytes,
      sha256: asset.sha256,
      provenance: asset.provenance,
      inputReceipts: asset.inputReceipts,
      verified: bytes === asset.bytes && digest.digest('hex') === asset.sha256,
    });
  }
  process.stdout.write(
    JSON.stringify({
      platform: record.platform,
      postId: record.postId,
      recordId: record.id,
      reused: accepted.reused,
      capturedAt: record.metadata?.capturedAt ?? null,
      resolution: record.resolutionState,
      download: record.downloadState,
      primaryItems: record.media.filter((media) => media.required).length,
      receipts,
      warnings: record.metadata?.warnings ?? [],
      error: record.error,
      timedOut: pending(record),
    }) + '\n',
  );
  if (
    record.resolutionState !== 'resolved' ||
    pending(record) ||
    receipts.some((receipt) => !receipt.verified) ||
    (downloadContent && record.downloadState !== 'complete')
  )
    process.exitCode = 1;
} finally {
  await backend.app.close();
}
