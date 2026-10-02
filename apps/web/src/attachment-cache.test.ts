import { describe, expect, it } from "vitest";
import { AttachmentCiphertextCache } from "./attachment-cache";

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
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException("missing", "NotFoundError");
    },
    async *values() {
      for (const name of files.keys()) {
        yield {
          kind: "file",
          name,
          async getFile() { return new File([files.get(name)!.slice().buffer as ArrayBuffer], name); },
        };
      }
    },
  };
  return { async getDirectoryHandle() { return directory; } } as unknown as FileSystemDirectoryHandle;
}

describe("AttachmentCiphertextCache", () => {
  it("durably reads ciphertext by opaque attachment id and removes it", async () => {
    const root = fakeOpfs();
    const cache = new AttachmentCiphertextCache(async () => root);
    const id = "opaque_attachment_1234";
    expect(await cache.put(id, new Uint8Array([1, 2, 3]).buffer)).toBe(true);
    expect(Array.from(new Uint8Array((await cache.get(id))!))).toEqual([1, 2, 3]);
    await cache.remove(id);
    expect(await cache.get(id)).toBeNull();
  });

  it("rejects path-like identifiers", async () => {
    const cache = new AttachmentCiphertextCache(async () => fakeOpfs());
    expect(await cache.put("../../secret", new ArrayBuffer(1))).toBe(false);
    expect(await cache.get("../../secret")).toBeNull();
  });

  it("enumerates cached ciphertext in stable identifier order", async () => {
    const root = fakeOpfs();
    const cache = new AttachmentCiphertextCache(async () => root);
    await cache.put("opaque_attachment_b", new Uint8Array([2]).buffer);
    await cache.put("opaque_attachment_a", new Uint8Array([1]).buffer);
    const entries = await cache.entries();
    expect(entries.map((entry) => entry.id)).toEqual(["opaque_attachment_a", "opaque_attachment_b"]);
    expect(Array.from(new Uint8Array(await entries[0]!.ciphertext.arrayBuffer()))).toEqual([1]);
  });

  it("fails closed when the browser cannot enumerate OPFS", async () => {
    const root = fakeOpfs();
    const directory = await root.getDirectoryHandle("attachment-ciphertext-v1");
    Object.defineProperty(directory, "values", { value: undefined });
    const cache = new AttachmentCiphertextCache(async () => root);
    await expect(cache.entries()).rejects.toThrow("cannot enumerate");
  });
});
