import { describe, expect, it } from "vitest";
import { createDeviceHistoryBundle, openDeviceHistoryBundle } from "./device-history-bundle";

describe("device history bundle", () => {
  it("packs database, attachment, and archive ciphertexts into the existing sharded handoff", async () => {
    const database = new Blob([new Uint8Array([1, 2, 3])], { type: "application/gzip" });
    const bundle = await createDeviceHistoryBundle(database, [
      { id: "attachment_opaque_001", ciphertext: new Blob([new Uint8Array([4, 5])]) },
      { id: "attachment_opaque_002", ciphertext: new Blob([new Uint8Array([6, 7, 8])]) },
    ], [{ id: "segment_opaque_000001", ciphertext: new Blob([new Uint8Array([10, 11])]) }]);
    const opened = await openDeviceHistoryBundle(bundle);
    expect(Array.from(new Uint8Array(await opened.databaseSnapshot.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(opened.attachments.map((item) => item.id)).toEqual(["attachment_opaque_001", "attachment_opaque_002"]);
    expect(Array.from(new Uint8Array(await opened.attachments[1].ciphertext.arrayBuffer()))).toEqual([6, 7, 8]);
    expect(opened.segments.map((item) => item.id)).toEqual(["segment_opaque_000001"]);
    expect(Array.from(new Uint8Array(await opened.segments[0].ciphertext.arrayBuffer()))).toEqual([10, 11]);
  });

  it("accepts legacy gzip-only snapshots and rejects trailing or truncated bundle data", async () => {
    const legacy = new Blob([new Uint8Array([31, 139, 1])], { type: "application/gzip" });
    expect((await openDeviceHistoryBundle(legacy)).databaseSnapshot).toBe(legacy);
    expect((await openDeviceHistoryBundle(legacy)).segments).toEqual([]);
    const bundle = await createDeviceHistoryBundle(legacy, [{ id: "attachment_opaque_003", ciphertext: new Blob([new Uint8Array([9])]) }]);
    await expect(openDeviceHistoryBundle(bundle.slice(0, bundle.size - 1))).rejects.toThrow("损坏");
    await expect(openDeviceHistoryBundle(new Blob([bundle, new Uint8Array([0])]))).rejects.toThrow("损坏");
  });
});
