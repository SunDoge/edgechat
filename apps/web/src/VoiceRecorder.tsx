import { useEffect, useRef, useState } from "react";
import { IconMicrophone, IconPlayerStop, IconX } from "@tabler/icons-react";
import { ActionButton } from "./ui";

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
function elapsedLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceRecorder({ contextId, disabled, onRecorded, onError }: {
  contextId: string;
  disabled?: boolean;
  onRecorded(file: File): void;
  onError(message: string): void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);
  const cancelled = useRef(false);
  const chunks = useRef<Blob[]>([]);

  function cleanup() {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
    chunks.current = [];
    setRecording(false);
    setElapsed(0);
  }

  function stop(cancel = false) {
    if (cancel) cancelled.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  async function start() {
    if (disabled || recording) return;
    if (!supportsVoiceRecording()) { onError("此浏览器不支持录音，可改为上传音频文件"); return; }
    const requestedType = preferredVoiceMimeType();
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      chunks.current = [];
      cancelled.current = false;
      startedAt.current = Date.now();
      const active = new MediaRecorder(stream.current, { ...(requestedType ? { mimeType: requestedType } : {}), audioBitsPerSecond: 32_000 });
      recorder.current = active;
      active.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      active.onerror = () => { cancelled.current = true; onError("录音被浏览器中断"); cleanup(); };
      active.onstop = () => {
        const type = active.mimeType || chunks.current.find((chunk) => chunk.type)?.type || requestedType || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        if (!cancelled.current) {
          if (!blob.size) onError("没有录到声音");
          else if (blob.size > MAX_VOICE_BYTES) onError("录音超过 25 MB，请缩短后重试");
          else onRecorded(new File([blob], `voice-${new Date(startedAt.current).toISOString().replaceAll(":", "-")}.${extension(type)}`, { type }));
        }
        cleanup();
      };
      active.start(1_000);
      setRecording(true);
      timer.current = window.setInterval(() => {
        const next = Date.now() - startedAt.current;
        setElapsed(next);
        if (next >= MAX_VOICE_DURATION_MS) stop();
      }, 250);
    } catch (cause) {
      cleanup();
      onError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "未获得麦克风权限" : "无法开始录音");
    }
  }

  useEffect(() => () => { cancelled.current = true; stop(true); cleanup(); }, []);
  useEffect(() => { if (recording) stop(true); }, [contextId]);

  if (!recording) return <ActionButton variant="icon" aria-label="录制语音" isDisabled={disabled} onPress={() => void start()}><IconMicrophone className="size-5" /></ActionButton>;
  return <div className="flex h-10 shrink-0 items-center gap-1 rounded-xl bg-red-50 px-1.5 text-red-700">
    <span className="size-2 animate-pulse rounded-full bg-red-500" /><span className="min-w-9 text-xs tabular-nums">{elapsedLabel(elapsed)}</span>
    <ActionButton variant="icon" aria-label="完成录音" onPress={() => stop()} className="size-8 text-red-700 hover:bg-red-100"><IconPlayerStop className="size-4" /></ActionButton>
    <ActionButton variant="icon" aria-label="取消录音" onPress={() => stop(true)} className="size-8 text-red-700 hover:bg-red-100"><IconX className="size-4" /></ActionButton>
  </div>;
}
