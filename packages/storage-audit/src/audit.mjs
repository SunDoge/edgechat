import { Buffer } from "node:buffer";

/** @typedef {{ key: string, expectedBytes: number, createdAt: number, sources: string[], pendingWriteAt: number | null, pendingDeleteAt: number | null }} LedgerObject */
/** @typedef {{ key: string, size: number, lastModified: number }} BucketObject */

async function next(iterator) {
  const value = await iterator.next();
  return value.done ? null : value.value;
}

function compareKeys(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function blankCounts() {
  return {
    ledger_objects: 0, ledger_bytes: 0, r2_objects: 0, r2_bytes: 0,
    orphan_objects: 0, orphan_bytes: 0, missing_objects: 0, missing_bytes: 0,
    size_mismatch_objects: 0, size_delta_bytes: 0, stale_pending_writes: 0,
    stale_pending_deletes: 0, deferred_recent_objects: 0,
  };
}

/**
 * Compares two lexicographically sorted streams using bounded memory.
 * Findings are sampled for the final report and may also be streamed to onFinding.
 * @param {{ ledger: AsyncIterable<LedgerObject>, bucket: AsyncIterable<BucketObject>, now?: number, graceMs?: number, sampleLimit?: number, onFinding?: (finding: Record<string, unknown>) => void | Promise<void> }} options
 */
export async function auditStorage(options) {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? 30 * 60_000;
  const sampleLimit = options.sampleLimit ?? 100;
  const cutoff = now - graceMs;
  const counts = blankCounts();
  const samples = [];
  const emit = async (finding) => {
    if (samples.length < sampleLimit) samples.push(finding);
    await options.onFinding?.(finding);
  };
  const staleIntents = async (item) => {
    if (item.pendingWriteAt !== null && item.pendingWriteAt < cutoff) {
      counts.stale_pending_writes += 1;
      await emit({ type: "stale_pending_write", key: item.key, since: item.pendingWriteAt });
    }
    if (item.pendingDeleteAt !== null && item.pendingDeleteAt < cutoff) {
      counts.stale_pending_deletes += 1;
      await emit({ type: "stale_pending_delete", key: item.key, since: item.pendingDeleteAt });
    }
  };

  const ledgerIterator = options.ledger[Symbol.asyncIterator]();
  const bucketIterator = options.bucket[Symbol.asyncIterator]();
  let ledgerItem = await next(ledgerIterator);
  let bucketItem = await next(bucketIterator);
  let lastLedgerKey = null; let lastBucketKey = null;
  while (ledgerItem || bucketItem) {
    if (ledgerItem && lastLedgerKey !== null && compareKeys(ledgerItem.key, lastLedgerKey) <= 0) throw new Error("D1 ledger stream is not strictly ordered");
    if (bucketItem && lastBucketKey !== null && compareKeys(bucketItem.key, lastBucketKey) <= 0) throw new Error("R2 object stream is not strictly ordered");
    if (ledgerItem && (!bucketItem || compareKeys(ledgerItem.key, bucketItem.key) < 0)) {
      lastLedgerKey = ledgerItem.key;
      counts.ledger_objects += 1; counts.ledger_bytes += ledgerItem.expectedBytes;
      await staleIntents(ledgerItem);
      const durableReference = ledgerItem.sources.includes("attachment") || ledgerItem.sources.includes("archive") || ledgerItem.sources.includes("device_link");
      if (ledgerItem.pendingDeleteAt !== null) {
        if (ledgerItem.pendingDeleteAt >= cutoff) counts.deferred_recent_objects += 1;
      } else if (!durableReference && ledgerItem.pendingWriteAt !== null) {
        if (ledgerItem.pendingWriteAt >= cutoff) counts.deferred_recent_objects += 1;
      }
      else if (ledgerItem.createdAt >= cutoff) counts.deferred_recent_objects += 1;
      else {
        counts.missing_objects += 1; counts.missing_bytes += ledgerItem.expectedBytes;
        await emit({ type: "missing", key: ledgerItem.key, expected_bytes: ledgerItem.expectedBytes, sources: ledgerItem.sources });
      }
      ledgerItem = await next(ledgerIterator);
      continue;
    }
    if (bucketItem && (!ledgerItem || compareKeys(bucketItem.key, ledgerItem.key) < 0)) {
      lastBucketKey = bucketItem.key;
      counts.r2_objects += 1; counts.r2_bytes += bucketItem.size;
      if (bucketItem.lastModified >= cutoff) counts.deferred_recent_objects += 1;
      else {
        counts.orphan_objects += 1; counts.orphan_bytes += bucketItem.size;
        await emit({ type: "orphan", key: bucketItem.key, actual_bytes: bucketItem.size, last_modified: bucketItem.lastModified });
      }
      bucketItem = await next(bucketIterator);
      continue;
    }

    lastLedgerKey = ledgerItem.key; lastBucketKey = bucketItem.key;
    counts.ledger_objects += 1; counts.ledger_bytes += ledgerItem.expectedBytes;
    counts.r2_objects += 1; counts.r2_bytes += bucketItem.size;
    await staleIntents(ledgerItem);
    if (ledgerItem.expectedBytes !== bucketItem.size && Math.min(ledgerItem.createdAt, bucketItem.lastModified) < cutoff) {
      counts.size_mismatch_objects += 1;
      counts.size_delta_bytes += Math.abs(ledgerItem.expectedBytes - bucketItem.size);
      await emit({ type: "size_mismatch", key: ledgerItem.key, expected_bytes: ledgerItem.expectedBytes, actual_bytes: bucketItem.size, sources: ledgerItem.sources });
    } else if (ledgerItem.expectedBytes !== bucketItem.size) counts.deferred_recent_objects += 1;
    ledgerItem = await next(ledgerIterator); bucketItem = await next(bucketIterator);
  }
  const anomalyCount = counts.orphan_objects + counts.missing_objects + counts.size_mismatch_objects + counts.stale_pending_writes + counts.stale_pending_deletes;
  return { version: 1, audited_at: now, grace_ms: graceMs, healthy: anomalyCount === 0, anomaly_count: anomalyCount, counts, samples };
}
