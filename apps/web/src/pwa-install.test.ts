import { describe, expect, it } from "vitest";
import { fallbackPwaInstallState } from "./pwa-install";

describe("PWA installation fallback", () => {
  it("never asks an already installed application to install again", () => {
    expect(fallbackPwaInstallState({ installed: true, secure: true, ios: true })).toEqual({ status: "installed", platform: "ios" });
  });

  it("uses browser instructions when no native prompt is available", () => {
    expect(fallbackPwaInstallState({ installed: false, secure: true, ios: false })).toEqual({ status: "manual", platform: "browser" });
    expect(fallbackPwaInstallState({ installed: false, secure: true, ios: true })).toEqual({ status: "manual", platform: "ios" });
  });

  it("does not offer installation from an insecure origin", () => {
    expect(fallbackPwaInstallState({ installed: false, secure: false, ios: false }).status).toBe("unavailable");
  });
});
