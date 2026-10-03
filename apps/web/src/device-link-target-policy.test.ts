import { describe, expect, it } from "vitest";
import { deviceHistoryShardResumeAction } from "./device-link-target-policy";

describe("deviceHistoryShardResumeAction", () => {
  it("retries only acknowledgement after local staging survived a lost response", () => {
    expect(deviceHistoryShardResumeAction({ ready: true, acknowledged: false, hasLocalPlaintext: true }))
      .toBe("acknowledge_local");
  });

  it("downloads a remote-ready shard only when no local plaintext exists", () => {
    expect(deviceHistoryShardResumeAction({ ready: true, acknowledged: false, hasLocalPlaintext: false }))
      .toBe("download_and_acknowledge");
  });

  it("accepts an acknowledged shard only with its durable local copy", () => {
    expect(deviceHistoryShardResumeAction({ ready: false, acknowledged: true, hasLocalPlaintext: true })).toBe("complete");
    expect(deviceHistoryShardResumeAction({ ready: false, acknowledged: true, hasLocalPlaintext: false })).toBe("local_missing");
  });

  it("does not invent a shard absent from both server states", () => {
    expect(deviceHistoryShardResumeAction({ ready: false, acknowledged: false, hasLocalPlaintext: false })).toBe("remote_missing");
  });
});
