import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { File as NodeFile } from "node:buffer";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteStagedShare, loadStagedShare, normalizeStagedShare, SHARE_TARGET_MAX_FILE_BYTES, shareTargetErrorMessage, shareTargetId, sharedComposerText, stageLocalFiles } from "./share-target";

function stagedFile(name: string, size: number) {
  const blob = new Blob();
  Object.defineProperty(blob, "size", { value: size });
  return { blob, name, type: "application/octet-stream", size, last_modified: 1 };
}

function stageWithNativeIndexedDb(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const request = indexedDB.open("edgechat-share-target", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("shares", { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("shares", "readwrite");
      transaction.objectStore("shares").put(value);
      transaction.oncomplete = () => { database.close(); resolvePromise(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

describe("PWA share target", () => {
  it("combines title, text and URL without duplicate lines", () => {
    expect(sharedComposerText({ title: "Article", text: "Read this", url: "https://example.com" })).toBe("Article\nRead this\nhttps://example.com");
    expect(sharedComposerText({ title: "same", text: " same ", url: "" })).toBe("same");
  });

  it("accepts only opaque UUID staging references", () => {
    expect(shareTargetId("?share_target=123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(shareTargetId("?share_target=../../secret")).toBeNull();
  });

  it("provides actionable human-facing rejection copy", () => {
    expect(shareTargetErrorMessage("too_many_files")).toContain("10 个文件");
    expect(shareTargetErrorMessage("file_too_large")).toContain("25 MB");
    expect(shareTargetErrorMessage("files_too_large")).toContain("100 MB");
  });

  it("normalizes legacy single-file shares and accepts bounded multi-file shares", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const legacy = normalizeStagedShare({ version: 1, id, created_at: 1, title: "", text: "", url: "", file: stagedFile("old.txt", 4) }, id, 2);
    expect(legacy?.version).toBe(2);
    expect(legacy?.files.map((file) => file.name)).toEqual(["old.txt"]);
    const multi = normalizeStagedShare({ version: 2, id, created_at: 1, title: "", text: "caption", url: "", files: [stagedFile("a.jpg", 4), stagedFile("b.jpg", 8)] }, id, 2);
    expect(multi?.files).toHaveLength(2);
  });

  it("rejects excessive count, individual size, and aggregate size before sending", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const base = { version: 2 as const, id, created_at: 1, title: "", text: "", url: "" };
    expect(normalizeStagedShare({ ...base, files: Array.from({ length: 11 }, (_, index) => stagedFile(`${index}.bin`, 1)) }, id, 2)).toBeNull();
    expect(normalizeStagedShare({ ...base, files: [stagedFile("large.bin", SHARE_TARGET_MAX_FILE_BYTES + 1)] }, id, 2)).toBeNull();
    expect(normalizeStagedShare({ ...base, files: Array.from({ length: 5 }, (_, index) => stagedFile(`${index}.bin`, 21 * 1024 * 1024)) }, id, 2)).toBeNull();
  });

  it("declares a POST multipart share target handled by the service worker", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8")) as Record<string, unknown>;
    expect(manifest.share_target).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
    const worker = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
    expect(worker).toContain('url.pathname === "/share-target"');
    expect(worker).toContain("edgechat-share-target");
    expect(worker).toContain("SHARE_MAX_FILES = 10");
    expect(worker).toContain("SHARE_MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024");
  });

  it("reads the unchanged service-worker IndexedDB schema through Dexie", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174001";
    await stageWithNativeIndexedDb({ version: 2, id, created_at: 1, title: "Shared", text: "hello", url: "", files: [] });
    await expect(loadStagedShare(id, 2)).resolves.toMatchObject({ id, title: "Shared", text: "hello" });
    await deleteStagedShare(id);
    await expect(loadStagedShare(id, 2)).resolves.toBeNull();
  });

  it("stages file-handler launches locally with the same attachment limits", async () => {
    const share = await stageLocalFiles([
      new NodeFile(["one"], "one.txt", { type: "text/plain", lastModified: 10 }) as unknown as File,
      new NodeFile(["two"], "two.txt", { type: "text/plain", lastModified: 20 }) as unknown as File,
    ], 30);
    expect(share).toMatchObject({ version: 2, created_at: 30, files: [{ name: "one.txt", size: 3 }, { name: "two.txt", size: 3 }] });
    await expect(loadStagedShare(share.id, 31)).resolves.toMatchObject({ id: share.id, files: [{ name: "one.txt" }, { name: "two.txt" }] });
    await deleteStagedShare(share.id);

    const excessive = await stageLocalFiles(Array.from({ length: 11 }, (_, index) => new NodeFile(["x"], `${index}.txt`) as unknown as File), 40);
    expect(excessive).toMatchObject({ error: "too_many_files", files: [] });
    await expect(loadStagedShare(excessive.id, 41)).resolves.toMatchObject({ error: "too_many_files", files: [] });
    await deleteStagedShare(excessive.id);
  });

  it("declares bounded common file handlers that reuse the confirmation flow", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8")) as { launch_handler?: unknown; file_handlers?: Array<Record<string, unknown>> };
    expect(manifest.launch_handler).toEqual({ client_mode: "navigate-existing" });
    expect(manifest.file_handlers).toHaveLength(1);
    expect(manifest.file_handlers?.[0]).toMatchObject({ action: "/", name: "发送至 EdgeChat" });
    expect(JSON.stringify(manifest.file_handlers)).not.toContain("edgechat-backup");
  });
});
