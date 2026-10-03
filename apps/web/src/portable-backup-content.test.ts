import { describe, expect, it, vi } from "vitest";
import { createPortableBackupHistory, openPortableBackupHistory, restorePortableBackupMedia } from "./portable-backup-content";

describe("portable backup local history", () => {
  it("packs only exact locally cached ciphertext when requested", async () => {
    const attachment = { id: "attachment_opaque_001", ciphertext: new Blob([new Uint8Array([4, 5])]) };
    const segment = { id: "segment_opaque_000001", ciphertext: new Blob([new Uint8Array([6, 7, 8])]) };
    const attachmentCache = { entries: vi.fn(async () => [attachment]) };
    const archiveCache = { entries: vi.fn(async () => [segment]) };

    const created = await createPortableBackupHistory(new Blob([new Uint8Array([1, 2, 3])]), true, attachmentCache, archiveCache);
    const opened = await openPortableBackupHistory(created.historyBundle);
    expect(created).toMatchObject({ attachmentCount: 1, segmentCount: 1 });
    expect(opened.attachments.map((item) => item.id)).toEqual([attachment.id]);
    expect(opened.segments.map((item) => item.id)).toEqual([segment.id]);
  });

  it("creates a database-only bundle without enumerating media caches", async () => {
    const attachmentCache = { entries: vi.fn(async () => { throw new Error("must not enumerate"); }) };
    const archiveCache = { entries: vi.fn(async () => { throw new Error("must not enumerate"); }) };
    const created = await createPortableBackupHistory(new Blob([new Uint8Array([1])]), false, attachmentCache, archiveCache);
    const opened = await openPortableBackupHistory(created.historyBundle);
    expect(opened.attachments).toEqual([]); expect(opened.segments).toEqual([]);
    expect(attachmentCache.entries).not.toHaveBeenCalled(); expect(archiveCache.entries).not.toHaveBeenCalled();
  });

  it("restores ciphertext sequentially and fails closed on a local write error", async () => {
    const attachmentPut = vi.fn(async (_id: string, _ciphertext: ArrayBuffer) => true);
    const segmentPut = vi.fn(async (_id: string, _ciphertext: ArrayBuffer) => true);
    const missing = vi.fn(async (_id: string) => null);
    await restorePortableBackupMedia(
      [{ id: "attachment_opaque_001", ciphertext: new Blob([new Uint8Array([4, 5])]) }],
      [{ id: "segment_opaque_000001", ciphertext: new Blob([new Uint8Array([6])]) }],
      { get: missing, put: attachmentPut }, { get: missing, put: segmentPut },
    );
    expect(new Uint8Array(attachmentPut.mock.calls[0]![1] as ArrayBuffer)).toEqual(new Uint8Array([4, 5]));
    expect(new Uint8Array(segmentPut.mock.calls[0]![1] as ArrayBuffer)).toEqual(new Uint8Array([6]));

    await expect(restorePortableBackupMedia(
      [{ id: "attachment_opaque_002", ciphertext: new Blob([new Uint8Array([1])]) }], [],
      { get: missing, put: vi.fn(async () => false) }, { get: missing, put: segmentPut },
    )).rejects.toThrow("backup.error.restoreAttachment");
  });

  it("never overwrites a conflicting live cache object before database restore", async () => {
    const put = vi.fn(async () => true);
    await expect(restorePortableBackupMedia(
      [{ id: "attachment_opaque_003", ciphertext: new Blob([new Uint8Array([1, 2])]) }], [],
      { get: vi.fn(async () => new Uint8Array([9, 9]).buffer), put },
      { get: vi.fn(async () => null), put: vi.fn(async () => true) },
    )).rejects.toThrow("backup.error.invalidContents");
    expect(put).not.toHaveBeenCalled();
  });
});
