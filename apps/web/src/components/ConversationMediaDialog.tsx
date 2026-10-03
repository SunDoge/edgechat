import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { IconFile, IconMicrophone, IconPhoto, IconRefresh } from "@tabler/icons-solidjs";
import type { LocalRoomAttachment, LocalRoomAttachmentCursor, LocalRoomAttachmentPage } from "@edgechat/db";
import { useI18n } from "../i18n";
import { attachmentPresentation, embeddedImagePreviewUrl, normalizeAttachmentMetadata, type AttachmentMetadata, type AttachmentPresentation } from "../media";
import { Dialog } from "./primitives";

type MediaFilter = "all" | AttachmentPresentation;

export function roomAttachmentMetadata(item: LocalRoomAttachment): AttachmentMetadata | null {
  const normalized = normalizeAttachmentMetadata(item.metadata);
  return normalized?.id === item.attachment_id ? normalized : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function LocalImageThumbnail(props: { attachment: AttachmentMetadata; loadCached: (attachment: AttachmentMetadata) => Promise<ArrayBuffer | null> }) {
  const embeddedUrl = props.attachment.preview ? embeddedImagePreviewUrl(props.attachment.preview) : null;
  const [url, setUrl] = createSignal<string | null>(embeddedUrl);
  const [checked, setChecked] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;
  let active = true;

  async function load() {
    if (checked()) return;
    setChecked(true);
    try {
      const plaintext = await props.loadCached(props.attachment);
      if (!active || !plaintext) return;
      setUrl(URL.createObjectURL(new Blob([plaintext], { type: props.attachment.type })));
    } catch { /* A corrupt or unavailable local cache remains a placeholder. */ }
  }

  onMount(() => {
    if (!("IntersectionObserver" in window)) { void load(); return; }
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect(); void load();
    }, { rootMargin: "160px" });
    if (root) observer.observe(root);
  });
  onCleanup(() => { active = false; observer?.disconnect(); const current = url(); if (current?.startsWith("blob:")) URL.revokeObjectURL(current); });

  return <div ref={root} class="grid aspect-[4/3] w-full place-items-center overflow-hidden bg-neutral-100">
    <Show when={url()} fallback={<IconPhoto class="size-7 stroke-neutral-400"/>}>{(src) => <img src={src()} alt="" class="size-full object-cover" loading="lazy" decoding="async" onError={() => setUrl(null)}/>}</Show>
  </div>;
}

export function ConversationMediaDialog(props: {
  roomTitle: string;
  coverageComplete: boolean;
  loadPage: (cursor: LocalRoomAttachmentCursor | null) => Promise<LocalRoomAttachmentPage>;
  loadCachedImage: (attachment: AttachmentMetadata) => Promise<ArrayBuffer | null>;
  displayName: (userId: string) => string;
  onOpenMessage: (messageId: string) => void;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [items, setItems] = createSignal<Array<LocalRoomAttachment & { attachment: AttachmentMetadata; presentation: AttachmentPresentation }>>([]);
  const [cursor, setCursor] = createSignal<LocalRoomAttachmentCursor | null>(null);
  const [hasMore, setHasMore] = createSignal(true);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [filter, setFilter] = createSignal<MediaFilter>("all");
  const filtered = createMemo(() => filter() === "all" ? items() : items().filter((item) => item.presentation === filter()));

  async function loadMore() {
    if (loading() || !hasMore()) return;
    setLoading(true); setError("");
    try {
      const page = await props.loadPage(cursor());
      const normalized = page.items.flatMap((item) => {
        const attachment = roomAttachmentMetadata(item);
        return attachment ? [{ ...item, attachment, presentation: attachmentPresentation(attachment) }] : [];
      });
      setItems((current) => [...current, ...normalized]);
      setCursor(page.next_cursor); setHasMore(Boolean(page.next_cursor));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("media.error.load")); }
    finally { setLoading(false); }
  }

  onMount(() => void loadMore());
  const labels = (): Array<{ value: MediaFilter; label: string }> => [
    { value: "all", label: t("media.filters.all") }, { value: "image", label: t("media.filters.image") },
    { value: "audio", label: t("media.filters.audio") }, { value: "file", label: t("media.filters.file") },
  ];

  return <Dialog id="conversation-media" title={t("media.title")} description={t("media.description", { title: props.roomTitle })} onClose={props.onClose} class="sm:max-w-3xl">
    <div class="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-black/5 bg-white px-4 py-2" aria-label={t("media.filters.label")}>
      <For each={labels()}>{(item) => <button type="button" aria-pressed={filter() === item.value} class={`min-h-10 shrink-0 rounded-lg px-3 text-sm font-semibold ${filter() === item.value ? "bg-brand-soft text-brand" : "text-muted hover:bg-neutral-100"}`} onClick={() => setFilter(item.value)}>{item.label}</button>}</For>
    </div>
    <div class="p-4 sm:p-5">
      <Show when={!props.coverageComplete}><p class="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs/5 text-amber-900">{t("media.incomplete")}</p></Show>
      <Show when={items().length || loading()} fallback={<div class="grid min-h-52 place-content-center justify-items-center px-6 text-center"><IconPhoto class="size-8 stroke-neutral-300"/><p class="mt-3 text-sm font-medium text-ink">{t("media.empty.title")}</p><p class="mt-1 text-xs/5 text-muted">{t("media.empty.description")}</p></div>}>
        <Show when={filtered().length} fallback={<p class="py-16 text-center text-sm text-muted">{t("media.empty.filter")}</p>}>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3" role="list">
            <For each={filtered()}>{(item) => <div role="listitem" class="min-w-0"><button type="button" class="flex h-full w-full flex-col overflow-hidden rounded-xl bg-white text-left ring-1 ring-black/8 transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transform-none" onClick={() => props.onOpenMessage(item.message_id)}>
              <Show when={item.presentation === "image"} fallback={<div class="grid aspect-[4/3] place-items-center bg-neutral-100"><Show when={item.presentation === "audio"} fallback={<IconFile class="size-8 stroke-neutral-400"/>}><IconMicrophone class="size-8 stroke-neutral-400"/></Show></div>}>
                <LocalImageThumbnail attachment={item.attachment} loadCached={props.loadCachedImage}/>
              </Show>
              <span class="block w-full min-w-0 p-2.5"><strong class="block truncate text-sm font-medium text-ink">{item.presentation === "audio" && item.attachment.duration_ms ? t("media.voiceDuration", { seconds: Math.max(1, Math.round(item.attachment.duration_ms / 1000)) }) : item.attachment.name}</strong><small class="mt-1 block truncate text-xs text-muted">{props.displayName(item.sender)} · {new Date(Number(item.created_at)).toLocaleDateString(locale())} · {formatBytes(item.attachment.size)}</small></span>
            </button></div>}</For>
          </div>
        </Show>
      </Show>
      <Show when={error()}><div role="alert" class="mt-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"><span class="min-w-0">{error()}</span><button type="button" class="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 font-semibold hover:bg-red-100" onClick={() => void loadMore()}><IconRefresh class="size-4 shrink-0 stroke-red-600"/>{t("media.retry")}</button></div></Show>
      <Show when={hasMore() && !error()}><div class="mt-5 flex justify-center"><button type="button" disabled={loading()} class="min-h-10 rounded-lg bg-neutral-100 px-4 text-sm font-semibold text-ink hover:bg-neutral-200 disabled:opacity-60" onClick={() => void loadMore()}>{loading() ? t("media.loading") : t("media.loadOlder")}</button></div></Show>
    </div>
  </Dialog>;
}
