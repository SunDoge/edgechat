import { Show, createSignal, onCleanup } from "solid-js";
import { IconCamera, IconDeviceMobile, IconLink, IconShieldCheck } from "@tabler/icons-solidjs";
import { deviceFingerprint } from "@edgechat/messaging-core";
import type { ApiClient, DeviceLinkPreview } from "@edgechat/sync";
import { parseDeviceLinkInput } from "../device-linking";
import { Dialog } from "./primitives";

type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>> };
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

export function DeviceLinkApprovalDialog(props: { api: ApiClient; onApprove: (linkId: string) => Promise<void>; onClose: () => void }) {
  const [input, setInput] = createSignal("");
  const [preview, setPreview] = createSignal<DeviceLinkPreview | null>(null);
  const [fingerprint, setFingerprint] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  const [error, setError] = createSignal("");
  let video: HTMLVideoElement | undefined;
  let stream: MediaStream | null = null;
  let scanTimer: number | undefined;

  async function inspect(value = input()) {
    setBusy(true); setError(""); setConfirmed(false);
    try {
      const linkId = parseDeviceLinkInput(value);
      const next = await props.api.deviceLinkPreview(linkId);
      if (next.status === "complete" || next.status === "claimed" || next.status === "cancelled") throw new Error("这次设备链接已经结束");
      setPreview(next); setFingerprint(await deviceFingerprint(next.signing_key, next.encryption_key)); stopCamera();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取设备链接"); }
    finally { setBusy(false); }
  }

  function stopCamera() {
    window.clearTimeout(scanTimer); stream?.getTracks().forEach((track) => track.stop()); stream = null; setScanning(false);
  }

  async function scanFrame(detector: BarcodeDetectorLike) {
    if (!video || !stream) return;
    try {
      const result = await detector.detect(video);
      if (result[0]?.rawValue) { setInput(result[0].rawValue); await inspect(result[0].rawValue); return; }
    } catch { /* the next frame can still succeed */ }
    scanTimer = window.setTimeout(() => void scanFrame(detector), 250);
  }

  async function startCamera() {
    setError("");
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) return setError("此浏览器不能直接扫码，请复制链接后粘贴到下方");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      setScanning(true);
      queueMicrotask(async () => {
        if (!video || !stream) return;
        video.srcObject = stream; await video.play();
        await scanFrame(new Detector({ formats: ["qr_code"] }));
      });
    } catch { stopCamera(); setError("无法打开相机。请允许相机权限，或粘贴设备链接。"); }
  }

  async function approve() {
    const item = preview(); if (!item || !confirmed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onApprove(item.link_id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "设备链接没有完成，可再次尝试"); setBusy(false); }
  }

  onCleanup(stopCamera);

  return <Dialog id="approve-device-link" title="链接新设备" description={preview() ? "核对后才会允许访问你的对话" : "扫描新设备上的二维码，或粘贴链接"} onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="grid gap-4 p-5">
      <Show when={!preview()} fallback={<>
        <div class="flex items-center gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5"><span class="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft"><IconDeviceMobile class="size-5 stroke-brand"/></span><div class="min-w-0"><strong class="block truncate text-sm font-semibold text-ink">{preview()!.display_name}</strong><p class="mt-0.5 text-xs text-muted">请求作为你的另一台独立设备加入</p></div></div>
        <div class="rounded-xl border border-brand/20 bg-brand-soft/50 p-4"><div class="flex items-center gap-2"><IconShieldCheck class="size-4 stroke-brand"/><strong class="text-sm font-semibold text-ink">在新设备上核对这些字符</strong></div><div class="mt-3 grid grid-cols-4 gap-2 font-mono text-xs font-semibold tracking-wide text-ink">{fingerprint().split(" ").map((part) => <span class="rounded-md bg-white px-1 py-2 text-center ring-1 ring-black/8">{part}</span>)}</div></div>
        <label class="flex items-start gap-3 rounded-xl p-3 text-sm/6 text-ink ring-1 ring-black/10"><input type="checkbox" class="mt-1 size-4 shrink-0 accent-brand" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)}/><span>设备名称和全部八组字符都一致，这是我正在操作的新设备。</span></label>
        <div class="flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100" onClick={() => { setPreview(null); setConfirmed(false); }}>返回</button><button type="button" disabled={!confirmed() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:bg-neutral-300" onClick={() => void approve()}>{busy() ? "正在安全加入…" : "核对后批准"}</button></div>
      </>}>
        <Show when={scanning()}><div class="relative aspect-square overflow-hidden rounded-2xl bg-neutral-950"><video ref={video} muted playsinline class="size-full object-cover"/><div class="pointer-events-none absolute inset-[15%] rounded-xl border-2 border-white/80 shadow-[0_0_0_999px_rgb(0_0_0/0.25)]"/><button type="button" class="absolute bottom-3 left-1/2 h-9 -translate-x-1/2 rounded-lg bg-black/60 px-3 text-sm font-medium text-white backdrop-blur" onClick={stopCamera}>停止扫码</button></div></Show>
        <Show when={!scanning()}><button type="button" autofocus class="flex h-12 items-center justify-center gap-2 rounded-xl bg-brand text-sm font-semibold text-white hover:bg-brand-strong" onClick={() => void startCamera()}><IconCamera class="size-5 stroke-white"/>扫描二维码</button></Show>
        <div class="flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>或粘贴链接<span class="h-px flex-1 bg-black/10"/></div>
        <form class="grid gap-3" onSubmit={(event) => { event.preventDefault(); void inspect(); }}><label class="grid gap-2 text-sm font-medium text-ink" for="device-link-code">设备链接<input id="device-link-code" name="device_link" value={input()} onInput={(event) => setInput(event.currentTarget.value)} autocomplete="off" spellcheck={false} placeholder="粘贴链接或链接码" class="h-11 min-w-0 rounded-lg px-3 text-base ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand"/></label><button type="submit" disabled={!input().trim() || busy()} class="flex h-11 items-center justify-center gap-2 rounded-lg bg-neutral-900 text-sm font-semibold text-white disabled:bg-neutral-300"><IconLink class="size-4 stroke-white"/>{busy() ? "正在读取…" : "查看设备"}</button></form>
      </Show>
      <Show when={error()}><p role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error()}</p></Show>
      <p class="text-xs/5 text-muted">批准只允许这台设备加入现有加密对话。二维码本身不能读取消息，也不会自动批准。</p>
    </div>
  </Dialog>;
}
