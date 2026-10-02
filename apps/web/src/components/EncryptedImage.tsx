import { IconDownload, IconPhoto, IconRefresh } from "@tabler/icons-solidjs";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { AttachmentMetadata } from "../media";
import { Dialog } from "./primitives";

type LoadState = "idle" | "loading" | "ready" | "error";

export function EncryptedImage(props: {
  attachment: AttachmentMetadata;
  load: () => Promise<ArrayBuffer>;
  download: () => void;
  onDecrypted?: (plaintext: ArrayBuffer) => void;
  compact?: boolean;
}) {
  const [state, setState] = createSignal<LoadState>("idle");
  const [url, setUrl] = createSignal<string>();
  const [viewerOpen, setViewerOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;

  const aspectRatio = () => {
    const width = props.attachment.width;
    const height = props.attachment.height;
    return width && height ? `${Math.min(width, 4_000)} / ${Math.min(height, 4_000)}` : "4 / 3";
  };

  async function decrypt() {
    if (state() === "loading" || state() === "ready") return;
    setState("loading");
    try {
      const plaintext = await props.load();
      const nextUrl = URL.createObjectURL(new Blob([plaintext], { type: props.attachment.type }));
      props.onDecrypted?.(plaintext);
      const previous = url();
      setUrl(nextUrl);
      if (previous) URL.revokeObjectURL(previous);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  onMount(() => {
    if (!("IntersectionObserver" in window)) { void decrypt(); return; }
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect();
      void decrypt();
    }, { rootMargin: "240px" });
    if (root) observer.observe(root);
  });

  onCleanup(() => {
    observer?.disconnect();
    const currentUrl = url();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  });

  return <>
    <div ref={root} class={`${props.compact ? "min-w-0 w-full rounded-lg" : "mt-1 w-[min(19rem,70vw)] rounded-xl"} overflow-hidden bg-black/5 outline-1 -outline-offset-1 outline-black/10`} style={{ "aspect-ratio": props.compact ? "1 / 1" : aspectRatio() }}>
      <Show when={state() === "ready" && url()} fallback={
        <div class={`grid size-full place-content-center justify-items-center gap-2 px-3 text-center text-xs text-current/65 ${props.compact ? "min-h-24" : "min-h-40"}`}>
          <Show when={state() === "error"} fallback={<><span class="size-7 animate-pulse rounded-full bg-current/10"/><span>正在客户端解密图片…</span></>}>
            <IconPhoto class="size-6 opacity-45"/><span>图片解密失败</span>
            <button type="button" class="mt-1 flex h-9 items-center gap-1.5 rounded-lg bg-black/8 px-3 font-semibold hover:bg-black/12" onClick={() => void decrypt()}><IconRefresh class="size-4"/>重试</button>
          </Show>
        </div>
      }>{(imageUrl) => <button type="button" class="block size-full bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white" aria-label={`查看图片：${props.attachment.name}`} onClick={() => setViewerOpen(true)}><img src={imageUrl()} alt={props.attachment.name} class="size-full object-cover" loading="lazy" decoding="async"/></button>}</Show>
    </div>
    <Show when={viewerOpen() && url()}>{(imageUrl) => <Dialog id={`image-${props.attachment.id}`} title={props.attachment.name} description="图片已在此设备上解密" onClose={() => setViewerOpen(false)} class="sm:max-w-[min(92vw,1100px)]" footer={<div class="flex justify-end border-t border-black/5 px-5 py-3"><button type="button" class="flex h-10 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong" onClick={props.download}><IconDownload class="size-4 stroke-white"/>保存原图</button></div>}>
      <div class="grid max-h-[70dvh] place-items-center overflow-auto bg-neutral-950 p-3 sm:p-6"><img src={imageUrl()} alt={props.attachment.name} class="max-h-[62dvh] max-w-full object-contain"/></div>
    </Dialog>}</Show>
  </>;
}
