import { describe, expect, it } from "vitest";
import { ApiError } from "@edgechat/sync";
import { authErrorMessage } from "./auth-errors";

describe("authentication error copy", () => {
  it("turns protocol errors into concise recovery guidance", () => {
    expect(authErrorMessage(new ApiError("Too many requests", 429, "authentication_rate_limited"))).toBe("尝试次数过多，请一分钟后再试");
    expect(authErrorMessage(new ApiError("Invalid credentials", 401, "invalid_credentials"))).toBe("用户名或密码不正确");
    expect(authErrorMessage(new ApiError("Internal error", 503, "internal_error"))).toBe("服务器暂时不可用，请稍后再试");
  });

  it("keeps useful client-side errors and has a network fallback", () => {
    expect(authErrorMessage(new Error("浏览器无法生成设备密钥"))).toBe("浏览器无法生成设备密钥");
    expect(authErrorMessage(null)).toBe("无法连接服务器");
  });
});
