import { afterEach, describe, expect, it, vi } from "vitest";
import { preferredVoiceMimeType, supportsVoiceRecording } from "./VoiceRecorder";

describe("voice recording capability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a clear unsupported state when MediaRecorder is missing", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    expect(preferredVoiceMimeType()).toBe("");
    expect(supportsVoiceRecording()).toBe(false);
  });

  it("prefers Opus WebM when the browser supports it", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (type: string) => type === "audio/webm;codecs=opus" });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
    expect(preferredVoiceMimeType()).toBe("audio/webm;codecs=opus");
    expect(supportsVoiceRecording()).toBe(true);
  });
});
