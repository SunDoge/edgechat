import { describe, expect, it } from "vitest";
import { AttachmentCiphertextCache } from "./attachment-cache";

const PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "22222222-2222-4222-8222-222222222222";

function fakeOpfs(): FileSystemDirectoryHandle {
  const directories = new Map<string, Map<string, Uint8Array>>();
  const handles = new Map<string, ReturnType<typeof handle>>();
  const handle = (files: Map<string, Uint8Array>) => ({
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) throw new DOMException("missing", "NotFoundError");
      return { async getFile() { return new File([(files.get(name) ?? new Uint8Array()).slice().buffer as ArrayBuffer], name); }, async createWritable() { let staged = new Uint8Array(); return {
        async write(value: ArrayBuffer) { staged = new Uint8Array(value.slice(0)); }, async close() { files.set(name, staged); }, async abort() { staged = new Uint8Array(); },
      }; } };
    },
    async removeEntry(name: string) { if (!files.delete(name)) throw new DOMException("missing", "NotFoundError"); },
    async *values() { for (const name of files.keys()) yield { kind: "file", name, async getFile() { return new File([files.get(name)!.slice().buffer as ArrayBuffer], name); } }; },
  });
  return {
    async getDirectoryHandle(name: string) { let files = directories.get(name); if (!files) { files = new Map(); directories.set(name, files); } let directory = handles.get(name); if (!directory) { directory = handle(files); handles.set(name, directory); } return directory; },
    async removeEntry(name: string) { if (!directories.delete(name)) throw new DOMException("missing", "NotFoundError"); handles.delete(name); },
  } as unknown as FileSystemDirectoryHandle;
}

describe("AttachmentCiphertextCache", () => {
  it("durably reads ciphertext by opaque attachment id and removes it", async () => {
    const root = fakeOpfs();
    const cache = new AttachmentCiphertextCache(PROFILE, async () => root);
    const id = "opaque_attachment_1234";
    expect(await cache.put(id, new Uint8Array([1, 2, 3]).buffer)).toBe(true);
    expect(Array.from(new Uint8Array((await cache.get(id))!))).toEqual([1, 2, 3]);
    await cache.remove(id);
    expect(await cache.get(id)).toBeNull();
  });

  it("rejects path-like identifiers", async () => {
    const cache = new AttachmentCiphertextCache(PROFILE, async () => fakeOpfs());
    expect(await cache.put("../../secret", new ArrayBuffer(1))).toBe(false);
    expect(await cache.get("../../secret")).toBeNull();
  });

  it("enumerates cached ciphertext in stable identifier order", async () => {
    const root = fakeOpfs();
    const cache = new AttachmentCiphertextCache(PROFILE, async () => root);
    await cache.put("opaque_attachment_b", new Uint8Array([2]).buffer);
    await cache.put("opaque_attachment_a", new Uint8Array([1]).buffer);
    const entries = await cache.entries();
    expect(entries.map((entry) => entry.id)).toEqual(["opaque_attachment_a", "opaque_attachment_b"]);
    expect(Array.from(new Uint8Array(await entries[0]!.ciphertext.arrayBuffer()))).toEqual([1]);
  });

  it("fails closed when the browser cannot enumerate OPFS", async () => {
    const root = fakeOpfs();
    const directory = await root.getDirectoryHandle(`attachment-ciphertext-v1-${PROFILE}`);
    Object.defineProperty(directory, "values", { value: undefined });
    const cache = new AttachmentCiphertextCache(PROFILE, async () => root);
    await expect(cache.entries()).rejects.toThrow("cannot enumerate");
  });

  it("keeps ciphertext and cleanup isolated between local profiles", async () => {
    const root = fakeOpfs(); const id = "opaque_attachment_1234";
    const first = new AttachmentCiphertextCache(PROFILE, async () => root);
    const second = new AttachmentCiphertextCache(OTHER_PROFILE, async () => root);
    await first.put(id, new Uint8Array([1]).buffer); await second.put(id, new Uint8Array([2]).buffer);
    expect(Array.from(new Uint8Array((await first.get(id))!))).toEqual([1]);
    expect(Array.from(new Uint8Array((await second.get(id))!))).toEqual([2]);
    await first.clear();
    expect(await first.get(id)).toBeNull();
    expect(Array.from(new Uint8Array((await second.get(id))!))).toEqual([2]);
  });
});
