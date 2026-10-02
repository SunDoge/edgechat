import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { deviceHistoryStaging } from "./device-history-staging";

describe("Dexie device-history staging", () => {
  it("stores blobs and manifests and clears one link without touching another", async () => {
    const first = "link-first";
    const second = "link-second";
    await deviceHistoryStaging.saveSourceSnapshot(first, new Blob(["snapshot"]));
    await deviceHistoryStaging.saveSourceManifest(first, { shard_count: 2 });
    await deviceHistoryStaging.saveTargetPlaintextShard(first, 0, new Blob(["first-shard"]));
    await deviceHistoryStaging.saveTargetPlaintextShard(second, 0, new Blob(["second-shard"]));

    expect(await deviceHistoryStaging.sourceManifest<{ shard_count: number }>(first)).toEqual({ shard_count: 2 });
    // fake-indexeddb preserves the record but does not expose Node's Blob.text()
    // after cloning; production browsers preserve the Blob itself.
    expect(await deviceHistoryStaging.sourceSnapshot(first)).not.toBeNull();

    await deviceHistoryStaging.clearLink(first);

    await expect(deviceHistoryStaging.sourceSnapshot(first)).resolves.toBeNull();
    await expect(deviceHistoryStaging.sourceManifest(first)).resolves.toBeNull();
    await expect(deviceHistoryStaging.targetPlaintextShard(first, 0)).resolves.toBeNull();
    expect(await deviceHistoryStaging.targetPlaintextShard(second, 0)).not.toBeNull();
    await deviceHistoryStaging.clearLink(second);
  });
});
