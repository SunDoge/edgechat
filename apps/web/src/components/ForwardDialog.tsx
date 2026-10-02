import { For, Show, createMemo, createSignal } from "solid-js";
import { IconSearch } from "@tabler/icons-solidjs";
import type { LocalMessage } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import { messageAttachments, messageContacts, messageText, normalizeMessagePayload, type MessagePayload } from "../media";
import { avatarColor, initials, roomTitle } from "../presenters";
import { Avatar, Dialog } from "./primitives";

export function ForwardDialog(props: {
  messages: LocalMessage[];
  rooms: ServerRoom[];
  currentUserId: string;
  onForward: (roomId: RoomId) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [busyRoom, setBusyRoom] = createSignal<RoomId | null>(null);
  const [error, setError] = createSignal("");
  const summary = () => forwardSelectionSummary(props.messages);
  const available = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return props.rooms.filter((room) => !room.blocked_by_me && (!needle || roomTitle(room, props.currentUserId).toLocaleLowerCase().includes(needle)));
  });

  async function choose(roomId: RoomId) {
    if (busyRoom()) return;
    setBusyRoom(roomId); setError("");
    try { await props.onForward(roomId); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法转发消息"); setBusyRoom(null); }
  }

  return <Dialog id="forward-message" title={props.messages.length > 1 ? `转发 ${props.messages.length} 条消息` : "转发消息"} description="选择一个对话；附件不会重复上传" onClose={props.onClose}>
    <div class="grid gap-3 p-5">
      <div class="rounded-xl border border-black/8 bg-neutral-50 px-3 py-2.5 text-sm text-muted"><span class="line-clamp-2 break-words">{summary()}</span></div>
      <label class="relative" for="forward-room-search"><span class="sr-only">搜索对话</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="forward-room-search" class="h-10 w-full rounded-lg pl-9 pr-3 text-base ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="搜索对话" autofocus/></label>
      <div class="max-h-[50dvh] divide-y divide-black/5 overflow-y-auto"><For each={available()} fallback={<p class="py-8 text-center text-sm text-muted">没有可转发的对话</p>}>{(room) => {
        const title = () => roomTitle(room, props.currentUserId);
        return <button type="button" class="flex min-h-14 w-full items-center gap-3 rounded-lg px-1 text-left hover:bg-neutral-50 disabled:opacity-50" disabled={Boolean(busyRoom())} onClick={() => void choose(room.room_id)}><Avatar saved={room.purpose === "saved"} group={room.kind === "group"} label={initials(title())} color={avatarColor(room.room_id)}/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{title()}</strong><small class="block truncate text-xs text-muted">{room.purpose === "saved" ? "仅你和你的设备可读" : room.kind === "group" ? `${room.members.length} 位成员` : "端到端加密对话"}</small></span><span class="text-xs font-semibold text-brand">{busyRoom() === room.room_id ? "正在转发…" : "转发"}</span></button>;
      }}</For></div>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error()}</div></Show>
    </div>
  </Dialog>;
}

export function forwardSelectionSummary(messages: LocalMessage[]): string {
  if (messages.length > 1) {
    const attachmentCount = messages.reduce((count, message) => count + messageAttachments(normalizeMessagePayload((message.payload ?? {}) as MessagePayload, message.event_id)).length, 0);
    return `已选择 ${messages.length} 条消息${attachmentCount ? `，含 ${attachmentCount} 个附件` : ""}`;
  }
  const message = messages[0];
  if (!message) return "没有可转发的消息";
  const payload = normalizeMessagePayload((message.payload ?? {}) as MessagePayload, message.event_id);
  return messageText(payload).trim() || (messageContacts(payload).length ? "联系人名片" : messageAttachments(payload)[0]?.kind === "image" ? "图片" : messageAttachments(payload)[0]?.kind === "voice" ? "语音消息" : "附件");
}
