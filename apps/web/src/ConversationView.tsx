import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, FileTrigger, TextArea, TextField } from "react-aria-components";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IconArrowLeft, IconDownload, IconFile, IconPaperclip, IconSearch, IconSend } from "@tabler/icons-react";
import type { LocalMessage } from "@edgechat/db";
import { attachmentPresentation, embeddedImagePreviewUrl, messageAttachments, normalizeMessagePayload, type AttachmentMetadata, type MessagePayload } from "@edgechat/message-content";
import type { RoomId } from "@edgechat/protocol";
import type { ServerRoom, SessionIdentity } from "@edgechat/sync";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import { ActionButton } from "./ui";
import { VoiceRecorder } from "./VoiceRecorder";

type Props = {
  runtime: BrowserMessagingRuntime;
  room: ServerRoom;
  session: SessionIdentity;
  messages: LocalMessage[];
  loading: boolean;
  jumpMessageId: string | null;
  onJumpComplete(): void;
  onSearch(): void;
  onResolveRequest(decision: "accepted" | "rejected"): Promise<void>;
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
  return <div className="relative">
    {presentation === "image" && attachment.preview && <img src={embeddedImagePreviewUrl(attachment.preview)} alt="" className="max-h-64 max-w-full rounded-xl object-contain opacity-80 blur-[1px]" />}
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

export function ConversationView({ runtime, room, session, messages, loading, jumpMessageId, onJumpComplete, onSearch, onResolveRequest, onBack, onSend, onLoadOlder }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [resolvingRequest, setResolvingRequest] = useState(false);
  const composing = useRef(false);
  const previousRoom = useRef<RoomId | null>(null);
  const previousFirst = useRef<string | null>(null);
  const olderAnchor = useRef<{ height: number; top: number; first: string | null } | null>(null);
  const virtualizer = useVirtualizer({ count: messages.length, getScrollElement: () => scrollRef.current, estimateSize: () => 76, overscan: 8, getItemKey: (index) => messages[index]!.message_id });
  const virtualizerRef = useRef(virtualizer);
  const messageCountRef = useRef(messages.length);
  virtualizerRef.current = virtualizer;
  messageCountRef.current = messages.length;
  const requestCannotSend = room.request_status === "rejected" || (room.request_status === "pending"
    && (room.request_role === "recipient" || room.request_message_sent || messages.some((message) => message.sender === session.user_id)));

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    const height = Math.min(128, Math.max(44, composer.scrollHeight));
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 128 ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        root.style.setProperty("--edgechat-viewport-height", `${Math.round(viewport?.height ?? window.innerHeight)}px`);
        root.style.setProperty("--edgechat-viewport-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
        if (document.activeElement === composerRef.current && messageCountRef.current) {
          virtualizerRef.current.scrollToIndex(messageCountRef.current - 1, { align: "end" });
        }
      });
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--edgechat-viewport-height");
      root.style.removeProperty("--edgechat-viewport-top");
    };
  }, []);

  useEffect(() => {
    if (!messages.length) return;
    const changedRoom = previousRoom.current !== room.room_id;
    const appended = previousFirst.current === messages[0]?.message_id;
    const element = scrollRef.current;
    const nearBottom = element ? element.scrollHeight - element.clientHeight - element.scrollTop < 320 : true;
    if (changedRoom || (appended && nearBottom)) requestAnimationFrame(() => virtualizer.scrollToIndex(messages.length - 1, { align: "end" }));
    previousRoom.current = room.room_id;
    previousFirst.current = messages[0]?.message_id ?? null;
  }, [messages, room.room_id, virtualizer]);

  useLayoutEffect(() => {
    const anchor = olderAnchor.current;
    const element = scrollRef.current;
    if (!anchor || !element || anchor.first === (messages[0]?.message_id ?? null)) return;
    requestAnimationFrame(() => {
      element.scrollTop = anchor.top + Math.max(0, element.scrollHeight - anchor.height);
      olderAnchor.current = null;
    });
  }, [messages]);

  useEffect(() => {
    if (!jumpMessageId) return;
    const index = messages.findIndex((message) => message.message_id === jumpMessageId);
    if (index < 0) return;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(index, { align: "center" });
      window.setTimeout(onJumpComplete, 900);
    });
  }, [jumpMessageId, messages, onJumpComplete, virtualizer]);

  async function loadOlder() {
    const element = scrollRef.current;
    if (!element || olderAnchor.current) return;
    olderAnchor.current = { height: element.scrollHeight, top: element.scrollTop, first: messages[0]?.message_id ?? null };
    await onLoadOlder();
    if (olderAnchor.current?.first === (messages[0]?.message_id ?? null)) olderAnchor.current = null;
  }

  async function submit() {
    const content = text.trim();
    if (sending || requestCannotSend || (!content && !files.length)) return;
    setSending(true);
    try { setComposerError(""); await onSend(content, files); setText(""); setFiles([]); }
    finally { setSending(false); }
  }

  async function resolveRequest(decision: "accepted" | "rejected") {
    setResolvingRequest(true); setComposerError("");
    try { await onResolveRequest(decision); }
    catch (cause) { setComposerError(cause instanceof Error ? cause.message : "无法处理消息请求"); }
    finally { setResolvingRequest(false); }
  }

  function addFiles(list: FileList | null) {
    const incoming = Array.from(list ?? []);
    if (files.length + incoming.length > 10) { setComposerError("每条消息最多添加 10 个文件"); return; }
    if (incoming.some((file) => file.size > 25 * 1024 * 1024)) { setComposerError("单个文件不能超过 25 MB"); return; }
    setComposerError(""); setFiles((current) => [...current, ...incoming]);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault(); void submit();
  }

  const virtualItems = virtualizer.getVirtualItems();
  return <section className="fixed inset-x-0 top-[var(--edgechat-viewport-top,0px)] grid h-[var(--edgechat-viewport-height,100dvh)] min-h-0 grid-rows-[auto_1fr_auto] bg-chat md:static md:h-dvh" aria-label="当前对话">
    <div className="bg-white pt-[env(safe-area-inset-top)] md:pt-0"><header className="flex min-h-16 items-center gap-2 border-b border-black/5 px-2 sm:px-4">
      <ActionButton variant="icon" aria-label="返回对话列表" onPress={onBack} className="md:hidden"><IconArrowLeft className="size-5" /></ActionButton>
      <div className="min-w-0 flex-1"><h1 className="truncate font-semibold text-ink">{roomTitle(room, session.user_id)}</h1><p className="text-xs text-muted">端到端加密 · {room.purpose === "saved" ? "仅自己的设备" : `${room.members.length} 位成员`}</p></div>
      <ActionButton variant="icon" aria-label="搜索当前对话" onPress={onSearch}><IconSearch className="size-5" /></ActionButton>
    </header>{room.request_status === "pending" && room.request_role === "recipient" && <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950"><p className="min-w-0 flex-1">接受后才能回复或收发附件。</p><ActionButton variant="quiet" isDisabled={resolvingRequest} onPress={() => void resolveRequest("rejected")} className="h-9">拒绝</ActionButton><ActionButton isDisabled={resolvingRequest} onPress={() => void resolveRequest("accepted")} className="h-9">接受</ActionButton></div>}{room.request_status === "pending" && room.request_role === "requester" && requestCannotSend && <p className="border-b border-black/5 bg-white px-4 py-2 text-center text-xs text-muted">等待对方接受消息请求</p>}</div>
    <div ref={scrollRef} className="min-h-0 overflow-y-auto overscroll-contain" onScroll={(event) => { if (event.currentTarget.scrollTop < 80 && !loading) void loadOlder(); }}>
      {loading && <p className="py-3 text-center text-xs text-muted" role="status">正在读取消息…</p>}
      {!messages.length && !loading && <div className="grid min-h-full place-items-center p-8 text-center text-sm text-muted">还没有消息。发出第一条端到端加密消息。</div>}
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        <div className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${virtualItems[0]?.start ?? 0}px)` }}>
          {virtualItems.map((item) => <div key={item.key} data-index={item.index} data-message-id={messages[item.index]!.message_id} ref={virtualizer.measureElement} className={jumpMessageId === messages[item.index]!.message_id ? "rounded-2xl ring-2 ring-brand/40" : ""}><MessageRow runtime={runtime} message={messages[item.index]!} own={messages[item.index]!.sender === session.user_id} /></div>)}
        </div>
      </div>
    </div>
    <div className="border-t border-black/5 bg-white px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-2">
      {composerError && <p role="alert" className="mb-2 text-xs text-red-700">{composerError}</p>}
      {files.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{files.map((file, index) => <ActionButton key={`${file.name}:${index}`} variant="quiet" onPress={() => setFiles((current) => current.filter((_, item) => item !== index))} className="h-8 shrink-0 rounded-lg bg-neutral-100 px-2.5 text-xs">{file.name} ×</ActionButton>)}</div>}
      <div className="flex items-end gap-1.5">
        <FileTrigger allowsMultiple onSelect={addFiles}><ActionButton variant="icon" aria-label="添加附件" isDisabled={requestCannotSend}><IconPaperclip className="size-5" /></ActionButton></FileTrigger>
        {!files.length && <VoiceRecorder contextId={room.room_id} disabled={sending || requestCannotSend} onRecorded={(file) => setFiles([file])} onError={setComposerError} />}
        <TextField aria-label="消息输入" value={text} onChange={setText} isDisabled={requestCannotSend} className="min-w-0 flex-1"><TextArea ref={composerRef} rows={1} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={requestCannotSend ? "等待消息请求被接受" : "写一条消息"} className="max-h-32 min-h-11 w-full resize-none rounded-2xl bg-neutral-100 px-4 py-2.5 text-base/6 text-ink outline-none focus:ring-2 focus:ring-brand disabled:text-muted" /></TextField>
        <ActionButton variant="icon" aria-label="发送" isDisabled={sending || requestCannotSend || (!text.trim() && !files.length)} onPress={() => void submit()} className="bg-brand text-white hover:bg-brand-strong disabled:bg-neutral-200 disabled:text-neutral-400"><IconSend className="size-5" /></ActionButton>
      </div>
    </div>
  </section>;
}

export type ConversationRoomId = RoomId;
