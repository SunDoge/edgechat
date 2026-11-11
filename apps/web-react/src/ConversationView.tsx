import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, FileTrigger, TextArea, TextField } from "react-aria-components";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IconArrowLeft, IconDownload, IconFile, IconPaperclip, IconSend } from "@tabler/icons-react";
import type { LocalMessage } from "@edgechat/db";
import { attachmentPresentation, messageAttachments, normalizeMessagePayload, type AttachmentMetadata, type MessagePayload } from "@edgechat/message-content";
import type { RoomId } from "@edgechat/protocol";
import type { ServerRoom, SessionIdentity } from "@edgechat/sync";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import { ActionButton } from "./ui";

type Props = {
  runtime: BrowserMessagingRuntime;
  room: ServerRoom;
  session: SessionIdentity;
  messages: LocalMessage[];
  loading: boolean;
  onBack(): void;
  onSend(text: string, files: File[]): Promise<void>;
  onLoadOlder(): Promise<void>;
};

function roomTitle(room: ServerRoom, ownUserId: string): string {
  if (room.name) return room.name;
  if (room.purpose === "saved") return "已保存消息";
  return room.members.filter((member) => member.user_id !== ownUserId).map((member) => member.display_name).join("、") || "对话";
}

function AttachmentView({ runtime, attachment }: { runtime: BrowserMessagingRuntime; attachment: AttachmentMetadata }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const presentation = attachmentPresentation(attachment);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function open() {
    if (url || busy) return;
    setBusy(true); setError("");
    try { setUrl(URL.createObjectURL(await runtime.downloadAttachment(attachment))); }
    catch { setError("文件解密失败"); }
    finally { setBusy(false); }
  }

  if (url && presentation === "image") return <img src={url} alt={attachment.name} className="max-h-80 max-w-full rounded-xl object-contain" />;
  if (url && presentation === "audio") return <audio src={url} controls className="max-w-full" />;
  if (url) return <a href={url} download={attachment.name} className="flex min-h-11 items-center gap-2 rounded-lg bg-black/5 px-3 text-sm font-medium"><IconDownload className="size-4" />{attachment.name}</a>;
  return <div>
    <Button onPress={() => void open()} isDisabled={busy} className="flex min-h-11 max-w-full items-center gap-2 rounded-lg bg-black/5 px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand">
      <IconFile className="size-5 shrink-0" /><span className="min-w-0"><strong className="block truncate font-medium">{attachment.name}</strong><span className="block text-xs opacity-60">{busy ? "正在解密…" : `${Math.ceil(attachment.size / 1024)} KB`}</span></span>
    </Button>
    {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
  </div>;
}

function MessageRow({ runtime, message, own }: { runtime: BrowserMessagingRuntime; message: LocalMessage; own: boolean }) {
  let payload: MessagePayload | null = null;
  try { if (message.payload) payload = normalizeMessagePayload(message.payload as MessagePayload, message.message_id); } catch { /* quarantined UI fallback */ }
  const attachments = payload ? messageAttachments(payload).map((part) => part.attachment) : [];
  return <article className={`flex px-4 py-1 ${own ? "justify-end" : "justify-start"}`} aria-label={own ? "你发送的消息" : `${message.sender} 发送的消息`}>
    <div className={`max-w-[min(82%,36rem)] rounded-2xl px-3.5 py-2.5 shadow-sm ${own ? "rounded-br-md bg-brand text-white" : "rounded-bl-md bg-white text-ink ring-1 ring-black/5"}`}>
      {message.deleted_at ? <p className="text-sm italic opacity-60">此消息已撤回</p> : <>
        {message.plaintext && <p className="whitespace-pre-wrap break-words text-[15px]/6">{message.plaintext}</p>}
        {attachments.length > 0 && <div className={`grid gap-2 ${message.plaintext ? "mt-2" : ""}`}>{attachments.map((attachment) => <AttachmentView key={attachment.id} runtime={runtime} attachment={attachment} />)}</div>}
      </>}
      <time className="mt-1 block text-right text-[10px] opacity-55">{new Date(Number(message.created_at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </div>
  </article>;
}

export function ConversationView({ runtime, room, session, messages, loading, onBack, onSend, onLoadOlder }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const composing = useRef(false);
  const virtualizer = useVirtualizer({ count: messages.length, getScrollElement: () => scrollRef.current, estimateSize: () => 76, overscan: 8, getItemKey: (index) => messages[index]!.message_id });

  useEffect(() => {
    if (!messages.length) return;
    requestAnimationFrame(() => virtualizer.scrollToIndex(messages.length - 1, { align: "end" }));
  }, [messages.length, room.room_id]);

  async function submit() {
    const content = text.trim();
    if (sending || (!content && !files.length)) return;
    setSending(true);
    try { await onSend(content, files); setText(""); setFiles([]); }
    finally { setSending(false); }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault(); void submit();
  }

  const virtualItems = virtualizer.getVirtualItems();
  return <section className="grid h-dvh min-h-0 grid-rows-[4rem_1fr_auto] bg-chat" aria-label="当前对话">
    <header className="flex items-center gap-2 border-b border-black/5 bg-white px-2 sm:px-4">
      <ActionButton variant="icon" aria-label="返回对话列表" onPress={onBack} className="md:hidden"><IconArrowLeft className="size-5" /></ActionButton>
      <div className="min-w-0"><h1 className="truncate font-semibold text-ink">{roomTitle(room, session.user_id)}</h1><p className="text-xs text-muted">端到端加密 · {room.members.length} 位成员</p></div>
    </header>
    <div ref={scrollRef} className="min-h-0 overflow-y-auto overscroll-contain" onScroll={(event) => { if (event.currentTarget.scrollTop < 80 && !loading) void onLoadOlder(); }}>
      {loading && <p className="py-3 text-center text-xs text-muted" role="status">正在读取消息…</p>}
      {!messages.length && !loading && <div className="grid min-h-full place-items-center p-8 text-center text-sm text-muted">还没有消息。发出第一条端到端加密消息。</div>}
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        <div className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${virtualItems[0]?.start ?? 0}px)` }}>
          {virtualItems.map((item) => <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}><MessageRow runtime={runtime} message={messages[item.index]!} own={messages[item.index]!.sender === session.user_id} /></div>)}
        </div>
      </div>
    </div>
    <div className="border-t border-black/5 bg-white px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-2">
      {files.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{files.map((file, index) => <button key={`${file.name}:${index}`} type="button" onClick={() => setFiles((current) => current.filter((_, item) => item !== index))} className="shrink-0 rounded-lg bg-neutral-100 px-2.5 py-1.5 text-xs text-ink">{file.name} ×</button>)}</div>}
      <div className="flex items-end gap-1.5">
        <FileTrigger allowsMultiple onSelect={(list) => setFiles((current) => [...current, ...Array.from(list ?? [])])}><ActionButton variant="icon" aria-label="添加附件"><IconPaperclip className="size-5" /></ActionButton></FileTrigger>
        <TextField aria-label="消息输入" value={text} onChange={setText} className="min-w-0 flex-1"><TextArea rows={1} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder="写一条消息" className="max-h-32 min-h-11 w-full resize-none rounded-2xl bg-neutral-100 px-4 py-2.5 text-base/6 text-ink outline-none focus:ring-2 focus:ring-brand" /></TextField>
        <ActionButton variant="icon" aria-label="发送" isDisabled={sending || (!text.trim() && !files.length)} onPress={() => void submit()} className="bg-brand text-white hover:bg-brand-strong disabled:bg-neutral-200 disabled:text-neutral-400"><IconSend className="size-5" /></ActionButton>
      </div>
    </div>
  </section>;
}

export type ConversationRoomId = RoomId;
