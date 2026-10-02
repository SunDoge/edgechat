import { describe, expect, it } from "vitest";
import { deviceLinkUrl, parseDeviceLinkInput, verificationWords } from "./device-linking";

describe("device-link handoff", () => {
  it("keeps the capability in the fragment and exposes only the link id to approval", () => {
    const url = deviceLinkUrl("https://chat.example", "abcdefghijklmnop", "secret-that-must-not-be-forwarded");
    expect(url).toBe("https://chat.example/#device-link?link_id=abcdefghijklmnop&secret=secret-that-must-not-be-forwarded");
    expect(new URL(url).search).toBe("");
    expect(parseDeviceLinkInput(url)).toBe("abcdefghijklmnop");
    expect(parseDeviceLinkInput("abcdefghijklmnop")).toBe("abcdefghijklmnop");
  });

  it("rejects malformed handoffs and groups fingerprints", () => {
    expect(() => parseDeviceLinkInput("https://chat.example/?secret=leaked")).toThrow("有效");
    expect(verificationWords("AAAA BBBB CCCC")).toEqual(["AAAA", "BBBB", "CCCC"]);
  });
});
