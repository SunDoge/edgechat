import { describe, expect, it } from "vitest";
import { ApiError, ApiTimeoutError } from "@edgechat/sync";
import { authErrorMessage } from "./auth-errors";
import { UserFacingError } from "./operation-errors";

describe("authentication error copy", () => {
  it("turns protocol errors into concise recovery guidance", () => {
    expect(authErrorMessage(new ApiError("Too many requests", 429, "authentication_rate_limited"))).toBe("尝试次数过多，请一分钟后再试");
    expect(authErrorMessage(new ApiError("Invalid credentials", 401, "invalid_credentials"))).toBe("用户名或密码不正确");
    expect(authErrorMessage(new ApiError("Schema mismatch", 503, "server_upgrade_required"))).toBe("服务器版本过旧，请联系管理员升级");
    expect(authErrorMessage(new ApiError("Internal error", 503, "internal_error"))).toBe("服务器暂时不可用，请稍后再试");
    expect(authErrorMessage(new ApiError("raw passkey trace", 401, "invalid_passkey_challenge"))).toBe("通行密钥验证失败或已过期，请重试");
    expect(authErrorMessage(new ApiError("raw provider limit", 409, "passkey_limit_reached"))).toBe("通行密钥数量已达上限，请先删除一个");
  });

  it("preserves explicit validation copy but hides unknown diagnostics", () => {
    expect(authErrorMessage(new UserFacingError("请先链接这台设备"))).toBe("请先链接这台设备");
    expect(authErrorMessage(UserFacingError.localized("deviceLink.error.invalidCode"))).toBe("这不是有效的设备链接码");
    expect(authErrorMessage(new Error("private/path/token"))).toBe("无法完成这台设备上的安全操作，请重试");
    expect(authErrorMessage(new ApiError("private backend detail", 400, "unknown_code"), undefined, "无法完成设置")).toBe("无法完成设置");
  });

  it("distinguishes connection failures without exposing their detail", () => {
    expect(authErrorMessage(new TypeError("Failed to fetch https://private-origin"))).toBe("无法连接服务器");
    expect(authErrorMessage(new ApiTimeoutError(30_000))).toBe("无法连接服务器");
  });
});
