import { IconDownload, IconPhoto, IconRefresh } from "@tabler/icons-solidjs";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { useI18n } from "../i18n";
import type { AttachmentMetadata } from "../media";
import { Dialog } from "./primitives";

type LoadState = "checking" | "idle" | "loading" | "ready" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function EncryptedImage(props: {
  attachment: AttachmentMetadata;
  loadCached: () => Promise<ArrayBuffer | null>;
  load: () => Promise<ArrayBuffer>;
  download: () => void;
  onDecrypted?: (plaintext: ArrayBuffer) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = createSignal<LoadState>("checking");
  const [url, setUrl] = createSignal<string>();
  const [viewerOpen, setViewerOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;
  let active = true;

  const aspectRatio = () => {
    const width = props.attachment.width;
    const height = props.attachment.height;
    return width && height ? `${Math.min(width, 4_000)} / ${Math.min(height, 4_000)}` : "4 / 3";
  };

  function usePlaintext(plaintext: ArrayBuffer) {
    if (!active) return;
    const nextUrl = URL.createObjectURL(new Blob([plaintext], { type: props.attachment.type }));
    props.onDecrypted?.(plaintext);
    const previous = url();
    setUrl(nextUrl);
    if (previous) URL.revokeObjectURL(previous);
    setState("ready");
  }

  async function decrypt() {
    if (state() === "loading" || state() === "ready") return;
    setState("loading");
    try {
      usePlaintext(await props.load());
    } catch {
      if (active) setState("error");
    }
  }

  async function checkCache() {
    try {
      const plaintext = await props.loadCached();
      if (plaintext) usePlaintext(plaintext);
      else if (active) setState("idle");
    } catch { if (active) setState("idle"); }
  }

  onMount(() => {
    if (!("IntersectionObserver" in window)) { void checkCache(); return; }
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect();
      void checkCache();
    }, { rootMargin: "240px" });
    if (root) observer.observe(root);
  });

  onCleanup(() => {
    active = false;
    observer?.disconnect();
    const currentUrl = url();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  });

  return <>
    <div ref={root} class={`${props.compact ? "min-w-0 w-full rounded-lg" : "mt-1 w-[min(19rem,70vw)] rounded-xl"} overflow-hidden bg-black/5 outline-1 -outline-offset-1 outline-black/10`} style={{ "aspect-ratio": props.compact ? "1 / 1" : aspectRatio() }}>
      <Show when={state() === "ready" && url()} fallback={
        <div class={`grid size-full place-content-center justify-items-center gap-2 px-3 text-center text-xs text-current/65 ${props.compact ? "min-h-24" : "min-h-40"}`}>
          <Show when={state() === "idle"} fallback={<Show when={state() === "error"} fallback={<><span class="size-7 animate-pulse rounded-full bg-current/10"/><span>{state() === "loading" ? t("attachment.image.loading") : t("attachment.image.checkingCache")}</span></>}><IconPhoto class="size-6 opacity-45"/><span>{t("attachment.image.error")}</span><button type="button" class="mt-1 flex min-h-10 items-center gap-1.5 rounded-lg bg-black/8 px-3 font-semibold hover:bg-black/12" onClick={() => void decrypt()}><IconRefresh class="size-4"/>{t("attachment.image.retry")}</button></Show>}><IconPhoto class="size-6 opacity-45"/><button type="button" class="flex min-h-10 items-center gap-1.5 rounded-lg bg-black/8 px-3 font-semibold hover:bg-black/12" onClick={() => void decrypt()}><IconDownload class="size-4"/>{t("attachment.image.load", { size: formatBytes(props.attachment.size) })}</button></Show>
        </div>
      }>{(imageUrl) => <button type="button" class="block size-full bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white" aria-label={t("attachment.image.view", { name: props.attachment.name })} onClick={() => setViewerOpen(true)}><img src={imageUrl()} alt={props.attachment.name} class="size-full object-cover" loading="lazy" decoding="async"/></button>}</Show>
    </div>
    <Show when={viewerOpen() && url()}>{(imageUrl) => <Dialog id={`image-${props.attachment.id}`} title={props.attachment.name} description={t("attachment.image.localDescription")} onClose={() => setViewerOpen(false)} class="sm:max-w-[min(92vw,1100px)]" footer={<div class="flex justify-end border-t border-black/5 px-5 py-3"><button type="button" class="flex h-10 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong" onClick={props.download}><IconDownload class="size-4 stroke-white"/>{t("attachment.image.save")}</button></div>}>
      <div class="grid max-h-[70dvh] place-items-center overflow-auto bg-neutral-950 p-3 sm:p-6"><img src={imageUrl()} alt={props.attachment.name} class="max-h-[62dvh] max-w-full object-contain"/></div>
    </Dialog>}</Show>
  </>;
}
