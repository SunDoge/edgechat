import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { deviceHistoryStagingFor } from "./device-history-staging";

const FIRST_PROFILE = "11111111-1111-4111-8111-111111111111";
const SECOND_PROFILE = "22222222-2222-4222-8222-222222222222";

describe("Dexie device-history staging", () => {
  it("stores blobs and manifests and clears one link without touching another", async () => {
    const deviceHistoryStaging = deviceHistoryStagingFor(FIRST_PROFILE);
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

  it("does not expose staging records to another local profile", async () => {
    const first = deviceHistoryStagingFor(FIRST_PROFILE); const second = deviceHistoryStagingFor(SECOND_PROFILE);
    await first.saveSourceManifest("shared-link", { owner: "first" });
    await second.saveSourceManifest("shared-link", { owner: "second" });
    expect(await first.sourceManifest("shared-link")).toEqual({ owner: "first" });
    expect(await second.sourceManifest("shared-link")).toEqual({ owner: "second" });
    await first.clearLink("shared-link"); await second.clearLink("shared-link");
  });

  it("clears every transfer for one profile without touching another", async () => {
    const first = deviceHistoryStagingFor(FIRST_PROFILE); const second = deviceHistoryStagingFor(SECOND_PROFILE);
    await first.saveSourceManifest("one", { owner: "first" });
    await first.saveTargetPlaintextShard("two", 0, new Blob(["first"]));
    await second.saveSourceManifest("one", { owner: "second" });
    await first.clearProfile();
    await expect(first.sourceManifest("one")).resolves.toBeNull();
    await expect(first.targetPlaintextShard("two", 0)).resolves.toBeNull();
    await expect(second.sourceManifest("one")).resolves.toEqual({ owner: "second" });
    await second.clearProfile();
  });
});
