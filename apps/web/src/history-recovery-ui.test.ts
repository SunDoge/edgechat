import { describe, expect, it } from "vitest";
import { historyRecoveryCopy, type HistoryRecoveryViewState } from "./history-recovery-ui";

describe("peer history recovery copy", () => {
  it("gives every state a concise user action or expectation without storage/protocol jargon", () => {
    const states: HistoryRecoveryViewState[] = [
      { phase: "requesting" }, { phase: "waiting" }, { phase: "transferring" }, { phase: "importing" }, { phase: "failed" },
    ];
    for (const state of states) {
      const copy = historyRecoveryCopy(state);
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.detail.length).toBeGreaterThan(5);
      expect(`${copy.title}${copy.detail}`).not.toMatch(/R2|S3|MLS|AEAD|ciphertext|recovery_id/i);
    }
  });

  it("shows the translated failure guidance supplied by the recovery controller", () => {
    expect(historyRecoveryCopy({ phase: "failed", message: "网络恢复后会自动继续。" })).toEqual({
      title: "恢复暂时中断", detail: "网络恢复后会自动继续。",
    });
  });
});
