import { describe, expect, it } from "vitest";
import { normalizeAccountIdentifier, validateAuthDraft } from "./auth-model";

describe("normalizeAccountIdentifier", () => {
  it("normalizes a federatable account identifier", () => {
    expect(normalizeAccountIdentifier("@Alice 你好:Example.COM")).toBe("@alice:example.com");
  });

  it("validates auth input at the UI boundary", () => {
    expect(validateAuthDraft({ mode: "register", displayName: "   ", username: "", password: "" })).toBe("请输入显示名称");
    expect(validateAuthDraft({ mode: "login", displayName: "", username: "@alice:example.com", password: "short" })).toContain("至少 10 位");
    expect(validateAuthDraft({ mode: "login", displayName: "", username: "@alice:example.com", password: "long-enough" })).toBeNull();
  });
});
