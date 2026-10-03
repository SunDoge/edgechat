import { Show, createSignal, onCleanup } from "solid-js";
import { IconCamera } from "@tabler/icons-solidjs";

type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>> };
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

export function supportsQrCameraScanning(): boolean {
  return typeof (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector === "function"
    && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function QrCameraScanner(props: {
  scanLabel: string;
  stopLabel: string;
  unsupportedMessage: string;
  cameraErrorMessage: string;
  onDetect: (value: string) => void | Promise<void>;
  onError: (message: string) => void;
  autofocus?: boolean;
}) {
  const [starting, setStarting] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  let video: HTMLVideoElement | undefined;
  let stream: MediaStream | null = null;
  let scanTimer: number | undefined;
  let stopped = false;
  let cameraRevision = 0;

  function stopCamera() {
    cameraRevision += 1;
    window.clearTimeout(scanTimer);
    scanTimer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    setScanning(false);
  }

  async function scanFrame(detector: BarcodeDetectorLike, revision: number) {
    if (!video || !stream || stopped || revision !== cameraRevision) return;
    try {
      const result = await detector.detect(video);
      if (revision !== cameraRevision) return;
      const value = result[0]?.rawValue;
      if (value) {
        stopCamera();
        await props.onDetect(value);
        return;
      }
    } catch { /* A later frame can still decode successfully. */ }
    if (stream && !stopped && revision === cameraRevision) scanTimer = window.setTimeout(() => void scanFrame(detector, revision), 250);
  }

  async function startCamera() {
    if (starting() || scanning()) return;
    props.onError("");
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (!supportsQrCameraScanning() || !Detector) return props.onError(props.unsupportedMessage);
    setStarting(true);
    const revision = ++cameraRevision;
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (stopped || revision !== cameraRevision) { opened.getTracks().forEach((track) => track.stop()); return; }
      stream = opened;
      setScanning(true);
      queueMicrotask(() => void (async () => {
        if (!video || !stream || stopped || revision !== cameraRevision) return;
        video.srcObject = stream;
        await video.play();
        await scanFrame(new Detector({ formats: ["qr_code"] }), revision);
      })().catch(() => {
        if (revision !== cameraRevision) return;
        const report = !stopped;
        stopCamera();
        if (report) props.onError(props.cameraErrorMessage);
      }));
    } catch {
      if (revision !== cameraRevision) return;
      const report = !stopped;
      stopCamera();
      if (report) props.onError(props.cameraErrorMessage);
    } finally {
      setStarting(false);
    }
  }

  onCleanup(() => { stopped = true; stopCamera(); });

  return <Show when={scanning()} fallback={<button type="button" autofocus={props.autofocus} disabled={starting()} aria-busy={starting()} class="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-semibold text-white hover:bg-brand-strong disabled:opacity-60" onClick={() => void startCamera()}><IconCamera class="size-5 stroke-white"/>{props.scanLabel}</button>}>
    <div class="relative aspect-square overflow-hidden rounded-2xl bg-neutral-950">
      <video ref={video} muted playsinline aria-label={props.scanLabel} class="size-full object-cover"/>
      <div class="pointer-events-none absolute inset-[15%] rounded-xl border-2 border-white/80 shadow-[0_0_0_999px_rgb(0_0_0/0.25)]"/>
      <button type="button" class="absolute bottom-3 left-1/2 h-9 -translate-x-1/2 rounded-lg bg-black/60 px-3 text-sm font-medium text-white backdrop-blur" onClick={stopCamera}>{props.stopLabel}</button>
    </div>
  </Show>;
}
