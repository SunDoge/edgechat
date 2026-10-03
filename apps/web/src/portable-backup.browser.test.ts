import { describe, expect, it } from "vitest";
import { AttachmentCiphertextCache } from "./attachment-cache";
import { ArchiveSegmentCiphertextCache } from "./archive-segment-cache";
import { createPortableBackupHistory, openPortableBackupHistory, restorePortableBackupMedia } from "./portable-backup-content";

describe("real browser portable media backup", () => {
  it("round-trips exact OPFS attachment and archive ciphertext without cloud access", async () => {
    try { await navigator.storage.getDirectory(); }
    catch {
      const packed = await createPortableBackupHistory(
        new Blob([new Uint8Array([31, 139, 1])]), false,
        { entries: async () => { throw new Error("must not enumerate unavailable OPFS"); } },
        { entries: async () => { throw new Error("must not enumerate unavailable OPFS"); } },
      );
      const opened = await openPortableBackupHistory(packed.historyBundle);
      expect(packed).toMatchObject({ attachmentCount: 0, segmentCount: 0 });
      expect(opened.attachments).toEqual([]); expect(opened.segments).toEqual([]);
      return;
    }
    const sourceProfile = crypto.randomUUID(); const targetProfile = crypto.randomUUID();
    const sourceAttachments = new AttachmentCiphertextCache(sourceProfile);
    const sourceSegments = new ArchiveSegmentCiphertextCache(sourceProfile);
    const targetAttachments = new AttachmentCiphertextCache(targetProfile);
    const targetSegments = new ArchiveSegmentCiphertextCache(targetProfile);
    const attachmentId = "attachment_backup_0001"; const segmentId = "segment_backup_000001";
    const attachmentBytes = new Uint8Array([1, 4, 9, 16]).buffer;
    const segmentBytes = new Uint8Array([2, 3, 5, 7, 11]).buffer;
    try {
      expect(await sourceAttachments.put(attachmentId, attachmentBytes)).toBe(true);
      expect(await sourceSegments.put(segmentId, segmentBytes)).toBe(true);
      const packed = await createPortableBackupHistory(new Blob([new Uint8Array([31, 139, 1])]), true, sourceAttachments, sourceSegments);
      const opened = await openPortableBackupHistory(packed.historyBundle);
      await restorePortableBackupMedia(opened.attachments, opened.segments, targetAttachments, targetSegments);

      expect(new Uint8Array((await targetAttachments.get(attachmentId))!)).toEqual(new Uint8Array(attachmentBytes));
      expect(new Uint8Array((await targetSegments.get(segmentId))!)).toEqual(new Uint8Array(segmentBytes));
    } finally {
      await Promise.all([sourceAttachments.clear(), sourceSegments.clear(), targetAttachments.clear(), targetSegments.clear()]);
    }
  });
});
