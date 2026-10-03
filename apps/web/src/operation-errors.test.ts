import { describe, expect, it } from "vitest";
import { ApiError, ApiTimeoutError } from "@edgechat/sync";
import { operationErrorMessage, UserFacingError } from "./operation-errors";

describe("operation error presentation", () => {
  it("preserves only explicitly user-facing validation errors", () => {
    expect(operationErrorMessage(new UserFacingError("请先恢复此对话"), "发送失败")).toBe("请先恢复此对话");
    expect(operationErrorMessage(UserFacingError.localized("backup.error.passwordOrDamage"), "无法恢复备份")).toBe("备份密码错误，或文件已经损坏");
    expect(operationErrorMessage(UserFacingError.localized("avatar.error.invalidDimensions"), "无法处理图片")).toBe("图片尺寸无效");
    expect(operationErrorMessage(UserFacingError.localized("localProfiles.error.cryptoRecovery"), "无法切换本机身份")).toBe("本机加密记录仍在恢复，完成后才能切换身份");
    expect(operationErrorMessage(UserFacingError.localized("workspace.composer.multiAttachmentUnsupported"), "发送失败")).toContain("请分开发送");
    expect(operationErrorMessage(UserFacingError.localized("workspace.feedback.firstUnreadUnavailable"), "无法打开对话")).toBe("无法打开第一条未读消息");
    if (false) {
      // @ts-expect-error Low-level errors cannot emit a key that needs runtime interpolation.
      UserFacingError.localized("deviceLink.rooms");
    }
  });

  it("maps transport, quota, rate and rollout failures without exposing raw diagnostics", () => {
    expect(operationErrorMessage(new ApiError("bucket quota internals", 413, "storage_quota_exceeded"), "发送失败")).toContain("云端存储");
    expect(operationErrorMessage(new ApiError("edge trace secret", 503, "internal_error"), "发送失败")).toBe("服务器暂时不可用，请稍后再试");
    expect(operationErrorMessage(new ApiError("limit internals", 429, "account_rate_limited"), "发送失败")).toBe("操作过于频繁，请稍后再试");
    expect(operationErrorMessage(new ApiTimeoutError(30_000), "发送失败")).toContain("检查网络");
    expect(operationErrorMessage(new ApiError("schema internals", 503, "server_upgrade_required"), "发送失败")).toContain("服务器版本过旧");
    expect(operationErrorMessage(new ApiError("checkpoint table trace", 409, "backup_stale"), "无法恢复备份")).toContain("避免加密密钥回滚");
    expect(operationErrorMessage(new ApiError("room mutation trace", 409, "room_membership_busy"), "无法批准设备")).toContain("群成员更新正在进行");
  });

  it("uses the operation-specific fallback for unknown internal failures", () => {
    expect(operationErrorMessage(new Error("private-path/secret-token"), "无法转发消息")).toBe("无法转发消息");
  });
});
