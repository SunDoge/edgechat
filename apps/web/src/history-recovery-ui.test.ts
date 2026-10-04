import { describe, expect, it } from "vitest";
import { ApiError } from "@edgechat/sync";
import { historyRecoveryCopy, historyRecoveryErrorKey, type HistoryRecoveryViewState } from "./history-recovery-ui";
import { translate } from "./i18n";
import { RoomPeerRecoveryError } from "./room-peer-recovery";

describe("peer history recovery copy", () => {
  it("gives every state a concise user action or expectation without storage/protocol jargon", () => {
    const states: HistoryRecoveryViewState[] = [
      { phase: "requesting" }, { phase: "waiting" }, { phase: "transferring" }, { phase: "importing" }, { phase: "failed" },
    ];
    for (const state of states) {
      const copy = historyRecoveryCopy(state, translate);
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.detail.length).toBeGreaterThan(5);
      expect(`${copy.title}${copy.detail}`).not.toMatch(/R2|S3|MLS|AEAD|ciphertext|recovery_id/i);
    }
  });

  it("shows only catalog-backed failure guidance supplied by the recovery controller", () => {
    expect(historyRecoveryCopy({ phase: "failed", errorKey: "workspace.historyRecovery.error.offline" }, translate)).toEqual({
      title: "恢复暂时中断", detail: "网络恢复后会自动继续。",
    });
    expect(historyRecoveryCopy({ phase: "failed" }, translate).detail).toBe("请检查网络后重试。");
    expect(historyRecoveryCopy({ phase: "failed", message: "raw provider diagnostic" } as unknown as HistoryRecoveryViewState, translate).detail)
      .toBe("请检查网络后重试。");
  });

  it("classifies recovery failures into stable actionable catalog keys", () => {
    expect(historyRecoveryErrorKey(new Error("provider secret"), false)).toBe("workspace.historyRecovery.error.offline");
    expect(historyRecoveryErrorKey(new ApiError("unavailable", 409, "peer_recovery_source_unavailable"), true))
      .toBe("workspace.historyRecovery.error.noSource");
    expect(historyRecoveryErrorKey(new ApiError("busy", 429, "rate_limited"), true)).toBe("workspace.historyRecovery.error.busy");
    expect(historyRecoveryErrorKey(new ApiError("origin detail", 503, "internal_error"), true)).toBe("workspace.historyRecovery.error.server");
    expect(historyRecoveryErrorKey(new RoomPeerRecoveryError("authentication_failed"), true)).toBe("workspace.historyRecovery.error.damaged");
    expect(historyRecoveryErrorKey(new Error("unknown crypto detail"), true)).toBe("workspace.historyRecovery.error.invalid");
  });
});
