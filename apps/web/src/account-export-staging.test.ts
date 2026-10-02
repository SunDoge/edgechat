import { describe, expect, it } from "vitest";
import { clearAccountExportStaging, createAccountExportStaging, createBoundedAccountExportBuffer, createBoundedConversationExportBuffer, createConversationExportStaging, isAccountExportStorageError } from "./account-export-staging";

const PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "22222222-2222-4222-8222-222222222222";

function fakeOpfs(failAtWrite?: number) {
  const files = new Map<string, Uint8Array>(); let writes = 0;
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) throw new DOMException("missing", "NotFoundError");
      if (!files.has(name)) files.set(name, new Uint8Array());
      return {
        async getFile() { return new File([(files.get(name) ?? new Uint8Array()).slice().buffer as ArrayBuffer], name); },
        async createWritable() {
          const parts: Uint8Array[] = [];
          return {
            async write(value: ArrayBuffer) { writes += 1; if (writes === failAtWrite) throw new DOMException("full", "QuotaExceededError"); parts.push(new Uint8Array(value.slice(0))); },
            async close() { const size = parts.reduce((sum, part) => sum + part.byteLength, 0); const output = new Uint8Array(size); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.byteLength; } files.set(name, output); },
            async abort() { parts.length = 0; },
          };
        },
      };
    },
    async removeEntry(name: string) { if (!files.delete(name)) throw new DOMException("missing", "NotFoundError"); },
    async *values() { for (const name of files.keys()) yield { kind: "file", name }; },
  };
  const root = {
    async getDirectoryHandle(_name: string, options?: { create?: boolean }) {
      if (!options?.create && files.size === 0) throw new DOMException("missing", "NotFoundError");
      return directory;
    },
  } as unknown as FileSystemDirectoryHandle;
  return { root, files };
}

describe("account export staging", () => {
  it("streams NDJSON lines in order and removes the exact temporary file", async () => {
    const opfs = fakeOpfs(); const staging = await createAccountExportStaging(PROFILE, async () => opfs.root);
    await staging.write('{"type":"manifest"}\n'); await staging.write('{"type":"room"}\n');
    const file = await staging.close();
    expect(await file.text()).toBe('{"type":"manifest"}\n{"type":"room"}\n');
    await staging.cleanup(); expect(opfs.files.size).toBe(0);
  });

  it("deletes a partial export after a write failure", async () => {
    const opfs = fakeOpfs(2); const staging = await createAccountExportStaging(PROFILE, async () => opfs.root);
    await staging.write("first\n");
    await expect(staging.write("second\n")).rejects.toThrow("full");
    await staging.abort(); expect(opfs.files.size).toBe(0);
  });

  it("keeps cleanup isolated between local profiles", async () => {
    const opfs = fakeOpfs();
    const first = await createAccountExportStaging(PROFILE, async () => opfs.root);
    const second = await createAccountExportStaging(OTHER_PROFILE, async () => opfs.root);
    await first.write("first\n"); await first.close(); await second.write("second\n"); await second.close();
    await clearAccountExportStaging(PROFILE, async () => opfs.root);
    expect([...opfs.files.keys()]).toHaveLength(1); expect([...opfs.files.keys()][0]).toMatch(new RegExp(`^${OTHER_PROFILE}-`));
    await second.cleanup();
  });

  it("bounds the legacy whole-Blob fallback by encoded bytes", () => {
    const buffer = createBoundedAccountExportBuffer(5);
    buffer.write("你"); buffer.write("ab");
    expect(buffer.bytes).toBe(5); expect(buffer.blob().size).toBe(5);
    expect(() => buffer.write("c")).toThrow("导出内容较大");
    expect(isAccountExportStorageError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isAccountExportStorageError(new DOMException("cancel", "AbortError"))).toBe(false);
  });

  it("uses a plaintext download type and includes conversation staging in profile cleanup", async () => {
    const buffer = createBoundedConversationExportBuffer(); buffer.write("聊天记录\n");
    expect(buffer.blob().type).toBe("text/plain;charset=utf-8");
    const opfs = fakeOpfs(); const staging = await createConversationExportStaging(PROFILE, async () => opfs.root);
    await staging.write("聊天记录\n"); await staging.close();
    expect([...opfs.files.keys()][0]).toMatch(/\.txt$/);
    await clearAccountExportStaging(PROFILE, async () => opfs.root);
    expect(opfs.files.size).toBe(0);
  });
});
