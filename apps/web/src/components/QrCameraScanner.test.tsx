import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QrCameraScanner } from "./QrCameraScanner";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks();
  Reflect.deleteProperty(window, "BarcodeDetector");
  Reflect.deleteProperty(navigator, "mediaDevices");
});

function installCamera(detect: () => Promise<Array<{ rawValue: string }>>) {
  const stop = vi.fn();
  Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: class { detect = detect; } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
  return stop;
}

function mount(onError = vi.fn(), onDetect = vi.fn(async () => undefined)) {
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => <QrCameraScanner scanLabel="扫描" stopLabel="停止" unsupportedMessage="不支持扫码" cameraErrorMessage="相机不可用" onError={onError} onDetect={onDetect}/>, root);
  return { onError, onDetect };
}

describe("QrCameraScanner", () => {
  it("stops every camera track when its owner is dismissed", async () => {
    const stop = installCamera(async () => new Promise(() => undefined));
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    mount();
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.querySelector("video")).not.toBeNull());

    dispose?.(); dispose = undefined;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the stream and exposes a recoverable error when video playback fails", async () => {
    const stop = installCamera(async () => []);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const { onError } = mount();
    document.querySelector<HTMLButtonElement>("button")!.click();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("相机不可用"));
    expect(stop).toHaveBeenCalledOnce();
    expect(document.querySelector("video")).toBeNull();
  });
});
