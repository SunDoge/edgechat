import { describe, expect, it } from "vitest";
import { clearPendingDeviceLink, deviceLinkUrl, loadPendingDeviceLink, parseDeviceLinkInput, savePendingDeviceLink, verificationWords } from "./device-linking";

describe("device-link handoff", () => {
  it("keeps the capability in the fragment and exposes only the link id to approval", () => {
    const url = deviceLinkUrl("https://chat.example", "abcdefghijklmnop", "secret-that-must-not-be-forwarded");
    expect(url).toBe("https://chat.example/#device-link?link_id=abcdefghijklmnop&secret=secret-that-must-not-be-forwarded");
    expect(new URL(url).search).toBe("");
    expect(parseDeviceLinkInput(url)).toBe("abcdefghijklmnop");
    expect(parseDeviceLinkInput("abcdefghijklmnop")).toBe("abcdefghijklmnop");
  });

  it("rejects malformed handoffs and groups fingerprints", () => {
    expect(() => parseDeviceLinkInput("https://chat.example/?secret=leaked")).toThrow("deviceLink.error.invalidCode");
    expect(verificationWords("AAAA BBBB CCCC")).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  it("persists both claim credentials for response-loss recovery and rejects malformed state", () => {
    const profileId = "12345678-1234-4123-8123-123456789abc";
    const pending = {
      version: 1 as const, link_id: "abcdefghijklmnop", secret: "link-secret", device_id: "new-device",
      package_count: 2, expires_at: Date.now() + 60_000, access_token: "A".repeat(43), device_credential: "B".repeat(43),
    };
    savePendingDeviceLink(profileId, pending);
    expect(loadPendingDeviceLink(profileId)).toEqual(pending);

    localStorage.setItem(`edgechat.pending-device-link.v1.${profileId}`, JSON.stringify({ ...pending, device_credential: "short" }));
    expect(loadPendingDeviceLink(profileId)).toBeNull();
    clearPendingDeviceLink(profileId);
  });
});
