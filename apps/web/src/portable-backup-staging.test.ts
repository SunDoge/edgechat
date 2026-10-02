import { describe, expect, it } from "vitest";
import type { PortableDeviceIdentity } from "@edgechat/messaging-core";
import { readPortableBackup } from "./portable-backup";
import { canCreateMemoryPortableBackup, clearPortableBackupStaging, MAX_MEMORY_BACKUP_SNAPSHOT_BYTES, stagePortableBackup } from "./portable-backup-staging";

const PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "correct horse battery staple";
const identity: PortableDeviceIdentity = {
  version: 1,
  device_id: "device-a",
  signing_private_key: { crv: "Ed25519", d: "private", kty: "OKP", x: "public" },
  encryption_private_key: { crv: "X25519", d: "private", kty: "OKP", x: "public" },
  mls_state: "state",
};

function backupInput(bytes = 150_000) {
  return {
    databaseSnapshot: new Blob([new Uint8Array(bytes).fill(7)]),
    identity,
    userId: "@alice:example.com",
    serverOrigin: "https://chat.example.com",
    backupCheckpoint: "a".repeat(32),
    password: PASSWORD,
  };
}

function fakeOpfs(failAtWrite?: number) {
  const directories = new Map<string, Map<string, { bytes: Uint8Array; lastModified: number }>>();
  let writes = 0;
  const root = {
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      let files = directories.get(name);
      if (!files && !options?.create) throw new DOMException("missing", "NotFoundError");
      if (!files) { files = new Map(); directories.set(name, files); }
      return {
        async getFileHandle(filename: string, fileOptions?: { create?: boolean }) {
          if (!files!.has(filename) && !fileOptions?.create) throw new DOMException("missing", "NotFoundError");
          if (!files!.has(filename)) files!.set(filename, { bytes: new Uint8Array(), lastModified: Date.now() });
          return {
            async getFile() {
              const entry = files!.get(filename)!;
              return new File([entry.bytes.slice().buffer as ArrayBuffer], filename, { lastModified: entry.lastModified });
            },
            async createWritable() {
              let parts: Uint8Array[] = [];
              return {
                async write(value: ArrayBuffer) {
                  writes += 1;
                  if (writes === failAtWrite) throw new Error("disk full");
                  parts.push(new Uint8Array(value.slice(0)));
                },
                async close() {
                  const size = parts.reduce((total, part) => total + part.byteLength, 0);
                  const bytes = new Uint8Array(size); let offset = 0;
                  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
                  files!.set(filename, { bytes, lastModified: Date.now() });
                },
                async abort() { parts = []; },
              };
            },
          };
        },
        async removeEntry(filename: string) {
          if (!files!.delete(filename)) throw new DOMException("missing", "NotFoundError");
        },
        async *values() {
          for (const [filename, entry] of files!) yield {
            kind: "file", name: filename,
            async getFile() { return new File([entry.bytes.slice().buffer as ArrayBuffer], filename, { lastModified: entry.lastModified }); },
          };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
  return { root, directories, writes: () => writes };
}

describe("portable backup OPFS staging", () => {
  it("streams encrypted chunks into a recoverable backup and removes the exact temporary file", async () => {
    const opfs = fakeOpfs();
    const staged = await stagePortableBackup(PROFILE, backupInput(), { rootProvider: async () => opfs.root, backupOptions: { chunkBytes: 64 * 1024, iterations: 100_000 } });
    expect(opfs.writes()).toBeGreaterThan(6);
    const restored = await readPortableBackup(staged.file, PASSWORD, "https://chat.example.com");
    expect(restored.databaseSnapshot.size).toBe(150_000);
    expect(restored.userId).toBe("@alice:example.com");
    await staged.cleanup();
    expect([...opfs.directories.values()][0]?.size).toBe(0);
  });

  it("removes a partial file when a streamed write fails", async () => {
    const opfs = fakeOpfs(5);
    await expect(stagePortableBackup(PROFILE, backupInput(), { rootProvider: async () => opfs.root, backupOptions: { chunkBytes: 64 * 1024, iterations: 100_000 } })).rejects.toThrow("disk full");
    expect([...opfs.directories.values()][0]?.size).toBe(0);
  });

  it("clears only staging files owned by the selected local profile", async () => {
    const opfs = fakeOpfs();
    const first = await stagePortableBackup(PROFILE, backupInput(1024), { rootProvider: async () => opfs.root, backupOptions: { chunkBytes: 64 * 1024, iterations: 100_000 } });
    const second = await stagePortableBackup(OTHER_PROFILE, backupInput(1024), { rootProvider: async () => opfs.root, backupOptions: { chunkBytes: 64 * 1024, iterations: 100_000 } });
    await clearPortableBackupStaging(PROFILE, async () => opfs.root);
    const directory = [...opfs.directories.values()][0]!;
    expect([...directory.keys()]).toHaveLength(1);
    expect([...directory.keys()][0]).toMatch(new RegExp(`^${OTHER_PROFILE}-`));
    await first.cleanup();
    await second.cleanup();
  });

  it("sweeps only abandoned exports for the same profile", async () => {
    const opfs = fakeOpfs();
    const old = await stagePortableBackup(PROFILE, backupInput(1024), { rootProvider: async () => opfs.root, backupOptions: { chunkBytes: 64 * 1024, iterations: 100_000 }, now: 1_000 });
    const directory = [...opfs.directories.values()][0]!;
    const oldEntry = [...directory.values()][0]!;
    oldEntry.lastModified = 1_000;
    await stagePortableBackup(PROFILE, backupInput(1024), { rootProvider: async () => opfs.root, backupOptions: { chunkBytes: 64 * 1024, iterations: 100_000 }, now: 1_000 + 24 * 60 * 60 * 1_000 });
    expect([...directory.keys()]).toHaveLength(1);
    await old.cleanup();
  });

  it("caps the whole-blob fallback to small snapshots", () => {
    expect(canCreateMemoryPortableBackup(MAX_MEMORY_BACKUP_SNAPSHOT_BYTES)).toBe(true);
    expect(canCreateMemoryPortableBackup(MAX_MEMORY_BACKUP_SNAPSHOT_BYTES + 1)).toBe(false);
    expect(canCreateMemoryPortableBackup(0)).toBe(false);
  });
});
