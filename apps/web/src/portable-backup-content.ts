import { createDeviceHistoryBundle, openDeviceHistoryBundle } from "./device-history-bundle";
import { UserFacingError } from "./user-facing-error";

export type CiphertextCacheEntry = { id: string; ciphertext: Blob };
export type EnumerableCiphertextCache = { entries(): Promise<CiphertextCacheEntry[]> };
export type WritableCiphertextCache = {
  get(id: string): Promise<ArrayBuffer | null>;
  put(id: string, ciphertext: ArrayBuffer): Promise<boolean>;
};

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function restoreEntries(entries: readonly CiphertextCacheEntry[], cache: WritableCiphertextCache, errorKey: "backup.error.restoreAttachment" | "backup.error.restoreSegment") {
  for (const entry of entries) {
    const ciphertext = await entry.ciphertext.arrayBuffer();
    let existing: ArrayBuffer | null;
    try { existing = await cache.get(entry.id); }
    catch { throw UserFacingError.localized(errorKey); }
    if (existing) {
      if (!equalBytes(existing, ciphertext)) throw UserFacingError.localized("backup.error.invalidContents");
      continue;
    }
    try {
      if (!await cache.put(entry.id, ciphertext)) throw UserFacingError.localized(errorKey);
    } catch (cause) {
      if (cause instanceof UserFacingError) throw cause;
      throw UserFacingError.localized(errorKey);
    }
  }
}

export async function createPortableBackupHistory(
  databaseSnapshot: Blob,
  includeCachedMedia: boolean,
  attachmentCache: EnumerableCiphertextCache,
  archiveCache: EnumerableCiphertextCache,
): Promise<{ historyBundle: Blob; attachmentCount: number; segmentCount: number }> {
  let attachments: CiphertextCacheEntry[] = [];
  let segments: CiphertextCacheEntry[] = [];
  if (includeCachedMedia) {
    try { [attachments, segments] = await Promise.all([attachmentCache.entries(), archiveCache.entries()]); }
    catch { throw UserFacingError.localized("backup.error.mediaUnavailable"); }
  }
  return {
    historyBundle: await createDeviceHistoryBundle(databaseSnapshot, attachments, segments),
    attachmentCount: attachments.length,
    segmentCount: segments.length,
  };
}

export async function openPortableBackupHistory(historyBundle: Blob) {
  try { return await openDeviceHistoryBundle(historyBundle); }
  catch { throw UserFacingError.localized("backup.error.invalidContents"); }
}

export async function restorePortableBackupMedia(
  attachments: readonly CiphertextCacheEntry[],
  segments: readonly CiphertextCacheEntry[],
  attachmentCache: WritableCiphertextCache,
  archiveCache: WritableCiphertextCache,
): Promise<void> {
  await restoreEntries(attachments, attachmentCache, "backup.error.restoreAttachment");
  await restoreEntries(segments, archiveCache, "backup.error.restoreSegment");
}
