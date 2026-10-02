import { Show, createSignal, onCleanup } from "solid-js";
import { IconDownload, IconPlayerPlay, IconRefresh } from "@tabler/icons-solidjs";
import type { AttachmentMetadata } from "../media";

type LoadState = "idle" | "loading" | "ready" | "error";

function durationLabel(milliseconds = 0): string {
  const safeMilliseconds = Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 10 * 60_000 ? milliseconds : 0;
  const seconds = Math.round(safeMilliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function EncryptedAudio(props: { attachment: AttachmentMetadata; load: () => Promise<ArrayBuffer>; download: () => void }) {
  const [state, setState] = createSignal<LoadState>("idle"); const [url, setUrl] = createSignal<string>();
  async function decrypt() {
    if (state() === "loading" || state() === "ready") return;
    setState("loading");
    try {
      const plaintext = await props.load(); const next = URL.createObjectURL(new Blob([plaintext], { type: props.attachment.type }));
      setUrl(next); setState("ready");
    } catch { setState("error"); }
  }
  function save() {
    const current = url();
    if (!current) return props.download();
    const anchor = document.createElement("a"); anchor.href = current; anchor.download = props.attachment.name; anchor.click();
  }
  onCleanup(() => { const current = url(); if (current) URL.revokeObjectURL(current); });
  return <div class="mt-2 flex min-w-56 items-center gap-2 rounded-xl bg-black/8 p-2">
    <Show when={state() === "ready" && url()} fallback={<button type="button" disabled={state() === "loading"} class="flex min-h-10 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm font-medium disabled:opacity-60" onClick={() => void decrypt()}>
      <Show when={state() === "error"} fallback={<IconPlayerPlay class="size-5 shrink-0 stroke-current"/>}><IconRefresh class="size-5 shrink-0 stroke-current"/></Show>
      <span>{state() === "loading" ? "正在本机解密…" : state() === "error" ? "重试播放" : "播放语音"}</span><span class="ml-auto text-xs opacity-65">{durationLabel(props.attachment.duration_ms)}</span>
    </button>}>{(audioUrl) => <audio class="h-10 min-w-0 flex-1" controls preload="metadata" src={audioUrl()}>你的浏览器无法播放这条语音。</audio>}</Show>
    <button type="button" aria-label="保存语音" class="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-black/8" onClick={save}><IconDownload class="size-4 stroke-current"/></button>
  </div>;
}
