import { describe, expect, it } from "vitest";
import { matchesDeviceHistoryTransfer, mayRetireDeviceLinkSourceState } from "./device-link-source-policy";

describe("linked-device source retention", () => {
  it("keeps the exact source snapshot after server completion until target claim", () => {
    expect(mayRetireDeviceLinkSourceState("approved")).toBe(false);
    expect(mayRetireDeviceLinkSourceState("complete")).toBe(false);
    expect(mayRetireDeviceLinkSourceState("claimed")).toBe(true);
    expect(mayRetireDeviceLinkSourceState("cancelled")).toBe(true);
  });

  it("allows repair only from the exact original transfer manifest", () => {
    const manifest = { transfer_id: "transfer_123456789", plaintext_bytes: 17, shard_plaintext_bytes: 16, shard_count: 2 };
    const transfer = { ...manifest, source_device_id: "source", ready_shards: [0], acked_shards: [], ciphertext_bytes: 20 };
    expect(matchesDeviceHistoryTransfer(manifest, transfer)).toBe(true);
    expect(matchesDeviceHistoryTransfer(manifest, { ...transfer, transfer_id: "different_123456" })).toBe(false);
    expect(matchesDeviceHistoryTransfer(manifest, { ...transfer, plaintext_bytes: 18 })).toBe(false);
    expect(matchesDeviceHistoryTransfer(manifest, { ...transfer, shard_count: 1 })).toBe(false);
  });
});
