import { describe, expect, it } from "vitest";
import { normalizeAccountIdentifier, validateAuthDraft } from "./auth-model";

describe("normalizeAccountIdentifier", () => {
  it("normalizes a federatable account identifier", () => {
    expect(normalizeAccountIdentifier("@Alice 你好:Example.COM")).toBe("@alice:example.com");
  });

  it("validates auth input at the UI boundary", () => {
    expect(validateAuthDraft({ mode: "register", registrationMode: "invite", displayName: "   ", inviteCode: "", username: "", password: "" })).toBe("请输入显示名称");
    expect(validateAuthDraft({ mode: "register", registrationMode: "invite", displayName: "Alice", inviteCode: "", username: "", password: "" })).toBe("请输入有效的邀请码");
    expect(validateAuthDraft({ mode: "register", registrationMode: "open", displayName: "Alice", username: "", password: "" })).toBeNull();
    expect(validateAuthDraft({ mode: "login", displayName: "", username: "@alice:example.com", password: "short" })).toContain("至少 10 位");
    expect(validateAuthDraft({ mode: "login", displayName: "", username: "@alice:example.com", password: "long-enough" })).toBeNull();
  });
});
