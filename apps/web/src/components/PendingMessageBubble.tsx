import { For, Show } from "solid-js";
import { IconMicrophone, IconPaperclip, IconRefresh } from "@tabler/icons-solidjs";
import type { OutboxItem } from "@edgechat/db";
import { messageAttachments, messageContacts, messageQuote, normalizeMessagePayload, type MessagePayload } from "../media";
import { userName } from "../presenters";
import { ContactCard } from "./ContactCard";

export function PendingMessageBubble(props: { message: OutboxItem; onRetry: () => void }) {
  const deleting = () => props.message.event.type === "message.delete";
  const relationLabel = () => props.message.event.type === "message.edit" ? "正在同步编辑…" : props.message.event.type === "message.reaction" ? "正在同步回应…" : null;
  const payload = () => normalizeMessagePayload(props.message.payload as MessagePayload, props.message.event_id);
  const quote = () => messageQuote(payload());
  const status = () => props.message.status === "sending" ? "正在发送…" : props.message.status === "failed" ? "发送失败" : props.message.attempts ? "等待重试" : "等待发送";
  return <div class="flex justify-end"><div class={`max-w-[82%] rounded-2xl rounded-br-md border px-3.5 py-2.5 sm:max-w-[72%] ${props.message.status === "failed" ? "border-red-200 bg-red-50 text-ink" : "border-brand/15 bg-brand/80 text-white"}`} data-message-id={props.message.message_id}>
    <Show when={relationLabel()} fallback={<Show when={deleting()} fallback={<><Show when={quote()}>{(snapshot) => <div class={`mb-2 rounded-lg border-l-2 px-2.5 py-1.5 text-left ${props.message.status === "failed" ? "border-red-300 bg-red-100/70" : "border-white/70 bg-white/10"}`}><span class="block truncate text-xs font-semibold">引用 {snapshot().display_name || userName(snapshot().sender)}</span><span class="mt-0.5 line-clamp-3 block whitespace-pre-wrap break-words text-xs opacity-75">{snapshot().text}</span></div>}</Show><Show when={props.message.plaintext}><p class="whitespace-pre-wrap break-words text-base/6">{props.message.plaintext}</p></Show><For each={messageAttachments(payload())}>{(part) => <div class={`mt-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium ${props.message.status === "failed" ? "bg-red-100/70" : "bg-white/10"}`}><Show when={part.kind === "voice"} fallback={<IconPaperclip class="size-4 shrink-0"/>}><IconMicrophone class="size-4 shrink-0"/></Show><span class="max-w-52 truncate">{part.kind === "voice" ? "语音消息" : part.attachment.name}</span><span class="text-xs opacity-70">{part.kind === "voice" ? `${Math.max(1, Math.round((part.attachment.duration_ms ?? 0) / 1000))} 秒` : `${(part.attachment.size / 1024).toFixed(1)} KB`}</span></div>}</For><For each={messageContacts(payload())}>{(part) => <ContactCard contact={part.contact} outgoing pending/>}</For></>}><p class="text-sm italic opacity-80">正在撤回消息…</p></Show>}><p class="text-sm italic opacity-80">{relationLabel()}</p></Show>
    <div class={`mt-1 flex items-center justify-end gap-2 text-[0.6875rem] ${props.message.status === "failed" ? "text-red-600" : "text-white/70"}`}><span>{status()}</span><Show when={props.message.status === "failed"}><button type="button" class="inline-flex items-center gap-1 font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500" onClick={props.onRetry}><IconRefresh class="size-3 stroke-red-600"/>重试</button></Show></div>
  </div></div>;
}
