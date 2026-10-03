import { For, Show, createMemo, createSignal } from "solid-js";
import { IconCheck, IconFile, IconSearch, IconSend } from "@tabler/icons-solidjs";
import type { RoomId } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import { useI18n, type Translator } from "../i18n";
import { avatarColor, initials, roomTitle } from "../presenters";
import { SHARE_TARGET_MAX_FILES, SHARE_TARGET_MAX_TEXT, sharedComposerText, type ShareTargetError, type StagedShare } from "../share-target";
import { Avatar, Dialog } from "./primitives";

export function ShareTargetDialog(props: {
  share: StagedShare;
  rooms: ServerRoom[];
  currentUserId: string;
  onSend: (roomId: RoomId, text: string, files: File[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = createSignal(sharedComposerText(props.share));
  const [query, setQuery] = createSignal("");
  const [selectedRoomId, setSelectedRoomId] = createSignal<RoomId | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const available = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return props.rooms.filter((room) => !room.blocked_by_me && (!needle || roomTitle(room, props.currentUserId).toLocaleLowerCase().includes(needle)));
  });
  const selectedRoom = createMemo(() => props.rooms.find((room) => room.room_id === selectedRoomId()));

  async function send() {
    const roomId = selectedRoomId();
    if (!roomId || busy() || props.share.error) return;
    const files = props.share.files.map((file, index) => new File([file.blob], file.name || `shared-file-${index + 1}`, { type: file.type || "application/octet-stream", lastModified: file.last_modified }));
    if (!text().trim() && !files.length) return setError(t("shareTarget.error.empty"));
    setBusy(true); setError("");
    try { await props.onSend(roomId, text().trim(), files); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("shareTarget.error.send")); setBusy(false); }
  }

  return <Dialog id="share-target" title={t("shareTarget.title")} description={t("shareTarget.description")} onClose={busy() ? () => undefined : props.onClose}>
    <div class="grid gap-4 p-5">
      <Show when={props.share.error} fallback={<>
        <Show when={props.share.files.length}><div class="overflow-hidden rounded-xl border border-black/8 bg-neutral-50"><div class="flex items-center justify-between border-b border-black/5 px-3 py-2"><strong class="text-xs font-semibold text-ink">{t("shareTarget.files", { count: props.share.files.length })}</strong><span class="text-xs tabular-nums text-muted">{formatBytes(props.share.files.reduce((total, file) => total + file.size, 0))} · {t("shareTarget.localOnly")}</span></div><div class="max-h-40 divide-y divide-black/5 overflow-y-auto"><For each={props.share.files}>{(file) => <div class="flex min-h-12 items-center gap-3 px-3 py-2"><span class="grid size-8 shrink-0 place-items-center rounded-lg bg-white shadow-sm"><IconFile class="size-4 stroke-muted"/></span><span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{file.name || t("shareTarget.unnamedFile")}</span><small class="shrink-0 text-xs tabular-nums text-muted">{formatBytes(file.size)}</small></div>}</For></div></div></Show>
        <label class="grid gap-2 text-sm font-medium text-ink" for="shared-text">{t("shareTarget.text")}<textarea id="shared-text" rows={3} maxlength={SHARE_TARGET_MAX_TEXT} class="min-h-24 resize-y rounded-xl bg-white px-3 py-2.5 text-base font-normal ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand" value={text()} onInput={(event) => setText(event.currentTarget.value)} placeholder={props.share.files.length ? t("shareTarget.textWithFiles") : t("shareTarget.textOnly")}/><span class="text-right text-xs font-normal tabular-nums text-neutral-400">{text().length}/{SHARE_TARGET_MAX_TEXT}</span></label>
        <div class="grid gap-2">
          <strong class="text-sm font-medium text-ink">{t("shareTarget.selectRoom")}</strong>
          <label class="relative" for="share-room-search"><span class="sr-only">{t("shareTarget.searchRooms")}</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="share-room-search" class="h-10 w-full rounded-lg pl-9 pr-3 text-base ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder={t("shareTarget.searchRooms")}/></label>
          <div class="max-h-[34dvh] divide-y divide-black/5 overflow-y-auto"><For each={available()} fallback={<p class="py-8 text-center text-sm text-muted">{t("shareTarget.noRooms")}</p>}>{(room) => {
            const title = () => roomTitle(room, props.currentUserId);
            const active = () => selectedRoomId() === room.room_id;
            return <button type="button" aria-pressed={active()} class={`flex min-h-14 w-full items-center gap-3 rounded-lg px-1 text-left ${active() ? "bg-brand-soft" : "hover:bg-neutral-50"}`} onClick={() => setSelectedRoomId(room.room_id)}><Avatar saved={room.purpose === "saved"} group={room.kind === "group"} label={initials(title())} color={avatarColor(room.room_id)}/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{title()}</strong><small class="block truncate text-xs text-muted">{room.purpose === "saved" ? t("roomTarget.saved") : room.kind === "group" ? t("roomTarget.group", { count: room.members.length }) : t("roomTarget.encrypted")}</small></span><Show when={active()}><IconCheck class="size-5 shrink-0 stroke-brand"/></Show></button>;
          }}</For></div>
        </div>
        <button type="button" disabled={!selectedRoom() || busy() || (!text().trim() && !props.share.files.length)} class="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50" onClick={() => void send()}><IconSend class="size-4 stroke-white"/>{busy() ? t("shareTarget.sending") : selectedRoom() ? t("shareTarget.sendTo", { title: roomTitle(selectedRoom()!, props.currentUserId) }) : t("shareTarget.selectBeforeSend")}</button>
      </>}><div role="alert" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{shareTargetErrorText(props.share.error!, t)}</div></Show>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error()}</div></Show>
    </div>
  </Dialog>;
}

function shareTargetErrorText(error: ShareTargetError, t: Translator): string {
  if (error === "too_many_files") return t("shareTarget.error.tooManyFiles", { count: SHARE_TARGET_MAX_FILES });
  if (error === "file_too_large") return t("shareTarget.error.fileTooLarge");
  if (error === "files_too_large") return t("shareTarget.error.filesTooLarge");
  if (error === "text_too_long") return t("shareTarget.error.textTooLong");
  if (error === "storage") return t("shareTarget.error.storage");
  return t("shareTarget.error.noContent");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
