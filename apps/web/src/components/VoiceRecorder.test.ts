import { afterEach, describe, expect, it, vi } from "vitest";
import { preferredVoiceMimeType } from "./VoiceRecorder";

describe("voice recorder codec selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers Opus WebM and falls back through supported containers", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (type: string) => type === "audio/ogg;codecs=opus" });
    expect(preferredVoiceMimeType()).toBe("audio/ogg;codecs=opus");
  });

  it("allows the browser to choose its native encoding when no preferred container is exposed", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(preferredVoiceMimeType()).toBe("");
  });
});
