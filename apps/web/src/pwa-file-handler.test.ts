import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import { describe, expect, it } from "vitest";
import { deleteStagedShare, loadStagedShare } from "./share-target";
import { stagePwaFileLaunch } from "./pwa-file-handler";

describe("PWA file handling", () => {
  it("reads handles only into bounded local staging", async () => {
    const calls: string[] = [];
    const id = await stagePwaFileLaunch([
      { getFile: async () => { calls.push("read"); return new NodeFile(["hello"], "hello.txt", { type: "text/plain" }) as unknown as File; } },
    ]);
    expect(calls).toEqual(["read"]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(loadStagedShare(id!)).resolves.toMatchObject({ files: [{ name: "hello.txt", size: 5 }] });
    await deleteStagedShare(id!);
  });

  it("ignores an empty operating-system launch", async () => {
    await expect(stagePwaFileLaunch([])).resolves.toBeNull();
  });

  it("bounds file-handle reads before recording an excessive launch", async () => {
    let reads = 0;
    const handles = Array.from({ length: 100 }, (_, index) => ({
      getFile: async () => { reads += 1; return new NodeFile(["x"], `${index}.txt`) as unknown as File; },
    }));
    const id = await stagePwaFileLaunch(handles);
    expect(reads).toBe(11);
    await expect(loadStagedShare(id!)).resolves.toMatchObject({ error: "too_many_files", files: [] });
    await deleteStagedShare(id!);
  });
});
