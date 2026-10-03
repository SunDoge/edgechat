import { Show, createSignal, onCleanup } from "solid-js";
import { IconDownload, IconPlayerPlay, IconRefresh } from "@tabler/icons-solidjs";
import { useI18n } from "../i18n";
import type { AttachmentMetadata } from "../media";

type LoadState = "idle" | "loading" | "ready" | "error";

function durationLabel(milliseconds = 0): string {
  const safeMilliseconds = Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 10 * 60_000 ? milliseconds : 0;
  const seconds = Math.round(safeMilliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function EncryptedAudio(props: { attachment: AttachmentMetadata; load: () => Promise<ArrayBuffer>; download: () => void }) {
  const { t } = useI18n();
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
      <span>{state() === "loading" ? t("attachment.audio.decrypting") : state() === "error" ? t("attachment.audio.retry") : t("attachment.audio.play")}</span><span class="ml-auto text-xs opacity-65">{durationLabel(props.attachment.duration_ms)}</span>
    </button>}>{(audioUrl) => <audio class="h-10 min-w-0 flex-1" controls preload="metadata" src={audioUrl()}>{t("attachment.audio.unsupported")}</audio>}</Show>
    <button type="button" aria-label={t("attachment.audio.save")} class="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-black/8" onClick={save}><IconDownload class="size-4 stroke-current"/></button>
  </div>;
}
