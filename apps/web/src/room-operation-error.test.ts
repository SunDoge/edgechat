import { describe, expect, it } from "vitest";
import { operationErrorMessage } from "./operation-errors";
import { RoomOperationError, type RoomOperationErrorCode } from "./room-operation-error";

describe("room operation errors", () => {
  it.each([
    ["crypto_not_ready", "加密状态尚未就绪"],
    ["membership_busy", "成员变更正在进行"],
    ["owner_required", "只有群主"],
    ["keys_changed", "已同步最新状态"],
    ["member_has_no_active_devices", "活跃设备"],
    ["owner_transfer_unsupported", "服务器版本"],
    ["owner_transfer_target_invalid", "当前群聊中的其他成员"],
    ["history_recovery_required", "恢复此群聊"],
    ["owner_transfer_pending", "群主转让正在发送"],
    ["peer_recovery_unsupported", "不支持设备间历史恢复"],
  ] satisfies Array<[RoomOperationErrorCode, string]>)("maps %s to actionable safe copy", (code, copy) => {
    const error = new RoomOperationError(code);
    expect(operationErrorMessage(error, "fallback")).toContain(copy);
    expect(operationErrorMessage(error, "fallback")).not.toBe(error.message);
  });
});
