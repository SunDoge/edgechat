import { describe, expect, it } from "vitest";
import { ArchiveSegmentCiphertextCache } from "./archive-segment-cache";

const PROFILE = "11111111-1111-4111-8111-111111111111";

function fakeOpfs(): FileSystemDirectoryHandle {
  const files = new Map<string, Uint8Array>();
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) throw new DOMException("missing", "NotFoundError");
      return {
        async getFile() { return new File([(files.get(name) ?? new Uint8Array()).slice().buffer as ArrayBuffer], name); },
        async createWritable() {
          let staged = new Uint8Array();
          return {
            async write(value: ArrayBuffer) { staged = new Uint8Array(value.slice(0)); },
            async close() { files.set(name, staged); },
            async abort() { staged = new Uint8Array(); },
          };
        },
      };
    },
    async removeEntry(name: string) { if (!files.delete(name)) throw new DOMException("missing", "NotFoundError"); },
    async *values() {
      for (const name of files.keys()) yield {
        kind: "file", name,
        async getFile() { return new File([files.get(name)!.slice().buffer as ArrayBuffer], name); },
      };
    },
  };
  return { async getDirectoryHandle() { return directory; } } as unknown as FileSystemDirectoryHandle;
}

describe("ArchiveSegmentCiphertextCache", () => {
  it("preserves exact encrypted segment bytes in stable identifier order", async () => {
    const root = fakeOpfs();
    const cache = new ArchiveSegmentCiphertextCache(PROFILE, async () => root);
    await cache.put("segment_000000000002", new Uint8Array([2, 3]).buffer);
    await cache.put("segment_000000000001", new Uint8Array([1]).buffer);
    const entries = await cache.entries();
    expect(entries.map((entry) => entry.id)).toEqual(["segment_000000000001", "segment_000000000002"]);
    expect(Array.from(new Uint8Array((await cache.get(entries[1]!.id))!))).toEqual([2, 3]);
    await cache.remove(entries[0]!.id);
    expect(await cache.get(entries[0]!.id)).toBeNull();
  });

  it("rejects path-like and empty segment objects", async () => {
    const cache = new ArchiveSegmentCiphertextCache(PROFILE, async () => fakeOpfs());
    expect(await cache.put("../../segment", new ArrayBuffer(1))).toBe(false);
    expect(await cache.put("segment_000000000001", new ArrayBuffer(0))).toBe(false);
  });
});
