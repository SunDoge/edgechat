import { describe, expect, it } from "vitest";
import { ApiError, ApiTimeoutError } from "@edgechat/sync";
import { operationErrorMessage, UserFacingError } from "./operation-errors";

describe("operation error presentation", () => {
  it("preserves only explicitly user-facing validation errors", () => {
    expect(operationErrorMessage(new UserFacingError("请先恢复此对话"), "发送失败")).toBe("请先恢复此对话");
  });

  it("maps transport, quota, rate and rollout failures without exposing raw diagnostics", () => {
    expect(operationErrorMessage(new ApiError("bucket quota internals", 413, "storage_quota_exceeded"), "发送失败")).toContain("云端存储");
    expect(operationErrorMessage(new ApiError("edge trace secret", 503, "internal_error"), "发送失败")).toBe("服务器暂时不可用，请稍后再试");
    expect(operationErrorMessage(new ApiError("limit internals", 429, "account_rate_limited"), "发送失败")).toBe("操作过于频繁，请稍后再试");
    expect(operationErrorMessage(new ApiTimeoutError(30_000), "发送失败")).toContain("检查网络");
    expect(operationErrorMessage(new ApiError("schema internals", 503, "server_upgrade_required"), "发送失败")).toContain("服务器版本过旧");
  });

  it("uses the operation-specific fallback for unknown internal failures", () => {
    expect(operationErrorMessage(new Error("private-path/secret-token"), "无法转发消息")).toBe("无法转发消息");
  });
});
