import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { IconMicrophone, IconPlayerStop, IconX } from "@tabler/icons-solidjs";
import { useI18n } from "../i18n";

export const MAX_VOICE_DURATION_MS = 10 * 60_000;
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

export function preferredVoiceMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function supportsVoiceRecording(): boolean {
  return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function extension(type: string): string { return type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"; }
function elapsedLabel(milliseconds: number): string { const seconds = Math.floor(milliseconds / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

export function VoiceRecorder(props: { contextId: string; disabled?: boolean; onRecorded: (file: File, durationMs: number) => void; onRecordingChange?: (active: boolean) => void; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [recording, setRecording] = createSignal(false); const [elapsed, setElapsed] = createSignal(0);
  let recorder: MediaRecorder | null = null; let stream: MediaStream | null = null; let timer: number | undefined; let startedAt = 0; let cancelled = false; let chunks: Blob[] = [];
  function cleanup() { window.clearInterval(timer); timer = undefined; stream?.getTracks().forEach((track) => track.stop()); stream = null; recorder = null; chunks = []; setRecording(false); setElapsed(0); props.onRecordingChange?.(false); }
  async function start() {
    if (props.disabled || recording()) return;
    const type = preferredVoiceMimeType();
    if (!supportsVoiceRecording()) return props.onError(t("voice.error.unsupported"));
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      chunks = []; cancelled = false; startedAt = Date.now(); recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32_000 });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { cancelled = true; props.onError(t("voice.error.interrupted")); cleanup(); };
      recorder.onstop = () => {
        const duration = Math.min(MAX_VOICE_DURATION_MS, Math.max(1, Date.now() - startedAt)); const blob = new Blob(chunks, { type: recorder?.mimeType || chunks.find((chunk) => chunk.type)?.type || type || "audio/webm" });
        if (!cancelled) {
          if (!blob.size) props.onError(t("voice.error.empty"));
          else if (blob.size > MAX_VOICE_BYTES) props.onError(t("voice.error.tooLarge"));
          else props.onRecorded(new File([blob], `voice-${new Date(startedAt).toISOString().replaceAll(":", "-")}.${extension(blob.type)}`, { type: blob.type }), duration);
        }
        cleanup();
      };
      recorder.start(1_000); setRecording(true); props.onRecordingChange?.(true);
      timer = window.setInterval(() => { const next = Date.now() - startedAt; setElapsed(next); if (next >= MAX_VOICE_DURATION_MS) recorder?.stop(); }, 250);
    } catch (cause) { cleanup(); props.onError(cause instanceof DOMException && cause.name === "NotAllowedError" ? t("voice.error.permission") : t("voice.error.start")); }
  }
  function stop() { if (recorder?.state === "recording") recorder.stop(); }
  function cancel() { cancelled = true; stop(); }
  let contextId = props.contextId;
  createEffect(() => { const next = props.contextId; if (next !== contextId && recording()) cancel(); contextId = next; });
  onCleanup(() => { cancelled = true; if (recorder?.state === "recording") recorder.stop(); else cleanup(); });
  return <Show when={recording()} fallback={<button type="button" aria-label={t("voice.record")} disabled={props.disabled} class="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-neutral-100 disabled:opacity-40" onClick={() => void start()}><IconMicrophone class="size-4 stroke-muted"/></button>}>
    <div class="flex h-9 shrink-0 items-center gap-1 rounded-lg bg-red-50 px-1.5 text-red-700"><span class="size-2 animate-pulse rounded-full bg-red-500"/><span class="min-w-9 text-xs tabular-nums">{elapsedLabel(elapsed())}</span><button type="button" aria-label={t("voice.stop")} class="grid size-8 place-items-center rounded-md hover:bg-red-100" onClick={stop}><IconPlayerStop class="size-4 stroke-red-600"/></button><button type="button" aria-label={t("voice.cancel")} class="grid size-8 place-items-center rounded-md hover:bg-red-100" onClick={cancel}><IconX class="size-4 stroke-red-600"/></button></div>
  </Show>;
}
