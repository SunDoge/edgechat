import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, FileTrigger, Menu, MenuItem, MenuTrigger, Popover, TextArea, TextField } from "react-aria-components";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { IconArrowLeft, IconDots, IconDownload, IconFile, IconPaperclip, IconSearch, IconSend } from "@tabler/icons-react";
import type { LocalMessage } from "@edgechat/db";
import { attachmentPresentation, embeddedImagePreviewUrl, messageAttachments, normalizeMessagePayload, type AttachmentMetadata, type MessagePayload } from "@edgechat/message-content";
import type { RoomId } from "@edgechat/protocol";
import type { ServerRoom, SessionIdentity } from "@edgechat/sync";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import { ActionButton } from "./ui";
import { VoiceRecorder } from "./VoiceRecorder";
import { copyText } from "./CopyButton";

const ChatUiInputExperiment = lazy(() => import("./ChatUiInputExperiment"));
const composerInputClass = "block max-h-32 min-h-11 w-full resize-none rounded-2xl bg-neutral-100 px-4 py-2.5 text-base/6 text-ink outline-none focus:ring-2 focus:ring-brand disabled:text-muted";

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
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 2500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);
  let payload: MessagePayload | null = null;
  try { if (message.payload) payload = normalizeMessagePayload(message.payload as MessagePayload, message.message_id); } catch { /* quarantined UI fallback */ }
  const attachments = payload ? messageAttachments(payload).map((part) => part.attachment) : [];
  const text = message.deleted_at ? "" : (message.plaintext ?? "");
  const lines = text.split("\n", 7);
  const preview = Array.from(lines.slice(0, 6).join("\n")).slice(0, 240).join("");
  const canExpand = preview.length < text.length;
  async function copy() {
    const copied = await copyText(text);
    if (!copied && canExpand) setExpanded(true);
    setCopyStatus(copied ? "已复制消息" : "无法自动复制，请长按消息复制。");
  }
  return <article className={`flex px-4 py-1 ${own ? "justify-end" : "justify-start"}`} aria-label={own ? "你发送的消息" : `${message.sender} 发送的消息`}>
    <div className={`min-w-0 max-w-[min(82%,36rem)] rounded-2xl px-3.5 py-2.5 shadow-sm ${own ? "rounded-br-md bg-brand text-white" : "rounded-bl-md bg-white text-ink ring-1 ring-black/5"}`}>
      {message.deleted_at ? <p className="text-sm italic opacity-60">此消息已撤回</p> : <>
        {text && <p className="whitespace-pre-wrap break-words text-[15px]/6">{canExpand && !expanded ? `${preview}…` : text}</p>}
        {attachments.length > 0 && <div className={`grid gap-2 ${message.plaintext ? "mt-2" : ""}`}>{attachments.map((attachment) => <AttachmentView key={attachment.id} runtime={runtime} attachment={attachment} />)}</div>}
      </>}
      <time className="mt-1 block text-right text-[10px] opacity-55">{new Date(Number(message.created_at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </div>
    {text && <div className={`shrink-0 self-end ${own ? "order-first" : ""}`}>
      <MenuTrigger>
        <ActionButton variant="icon" aria-label="消息操作" className="text-muted"><IconDots className="size-4" /></ActionButton>
        <Popover placement={own ? "top end" : "top start"} className="z-40 min-w-32 rounded-xl bg-white p-1 shadow-lg ring-1 ring-black/10">
          <Menu aria-label="消息操作" className="outline-none" onAction={(key) => {
            if (key === "copy") void copy();
            if (key === "expand") setExpanded((value) => !value);
          }}>
            <MenuItem id="copy" className="flex min-h-11 items-center rounded-lg px-3 text-sm outline-none focus:bg-brand-soft">复制消息</MenuItem>
            {canExpand && <MenuItem id="expand" className="flex min-h-11 items-center rounded-lg px-3 text-sm outline-none focus:bg-brand-soft">{expanded ? "收起全文" : "展开全文"}</MenuItem>}
          </Menu>
        </Popover>
      </MenuTrigger>
      <span role="status" className="sr-only">{copyStatus}</span>
      {copyStatus && <span aria-hidden="true" className="fixed inset-x-0 bottom-24 z-40 mx-auto w-fit rounded-lg bg-ink px-3 py-2 text-xs text-white">{copyStatus}</span>}
    </div>}
  </article>;
}

export function ConversationView({ runtime, room, session, messages, loading, jumpMessageId, onJumpComplete, onSearch, onResolveRequest, onBack, onSend, onLoadOlder }: Props) {
  const [chatUiExperiment] = useState(() => new URLSearchParams(location.search).get("composer") === "chatui");
  const timeline = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [resolvingRequest, setResolvingRequest] = useState(false);
  const composing = useRef(false);
  const firstId = messages[0]?.message_id ?? null;
  const [anchor, setAnchor] = useState({ firstId, index: 1_000_000, generation: 0 });
  if (anchor.firstId !== firstId) {
    const prepended = anchor.firstId ? messages.findIndex((message) => message.message_id === anchor.firstId) : -1;
    setAnchor(prepended > 0
      ? { ...anchor, firstId, index: anchor.index - prepended }
      : { firstId, index: 1_000_000, generation: anchor.generation + 1 });
  }
  const requestCannotSend = room.request_status === "rejected" || (room.request_status === "pending"
    && (room.request_role === "recipient" || room.request_message_sent || messages.some((message) => message.sender === session.user_id)));

  useLayoutEffect(() => {
    if (chatUiExperiment) return;
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    const height = Math.min(128, Math.max(44, composer.scrollHeight));
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 128 ? "auto" : "hidden";
  }, [text, chatUiExperiment]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;
    let previousHeight = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const height = Math.round(viewport?.height ?? window.innerHeight);
        const heightChanged = previousHeight !== height;
        previousHeight = height;
        root.style.setProperty("--edgechat-viewport-height", `${height}px`);
        root.style.setProperty("--edgechat-viewport-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
        if (heightChanged && document.activeElement === composerRef.current && atBottom.current) {
          timeline.current?.autoscrollToBottom();
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
    if (!jumpMessageId) return;
    const index = messages.findIndex((message) => message.message_id === jumpMessageId);
    if (index < 0) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timeline.current?.scrollToIndex({ index, align: "center" });
      timer = window.setTimeout(onJumpComplete, 900);
    });
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [jumpMessageId, messages, onJumpComplete]);

  async function loadOlder() {
    if (loading || loadingOlder.current || !messages.length) return;
    loadingOlder.current = true;
    try { await onLoadOlder(); }
    catch { setComposerError("无法读取较早的消息，请稍后重试。"); }
    finally { loadingOlder.current = false; }
  }

  async function submit() {
    const content = text.trim();
    if (sending || requestCannotSend || (!content && !files.length)) return;
    setSending(true);
    try { setComposerError(""); await onSend(content, files); setText(""); setFiles([]); }
    catch { setComposerError("消息发送失败，请重试。"); }
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

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault(); void submit();
  }

  const inputInteraction = {
    onKeyDown: keyDown,
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    placeholder: requestCannotSend ? "等待消息请求被接受" : "写一条消息",
    className: composerInputClass,
  };

  return <section className="fixed inset-x-0 top-[var(--edgechat-viewport-top,0px)] grid h-[var(--edgechat-viewport-height,100dvh)] min-h-0 grid-rows-[auto_1fr_auto] bg-chat md:static md:h-dvh" aria-label="当前对话">
    <div className="bg-white pt-[env(safe-area-inset-top)] md:pt-0"><header className="flex min-h-16 items-center gap-2 border-b border-black/5 px-2 sm:px-4">
      <ActionButton variant="icon" aria-label="返回对话列表" onPress={onBack} className="md:hidden"><IconArrowLeft className="size-5" /></ActionButton>
      <div className="min-w-0 flex-1"><h1 className="truncate font-semibold text-ink">{roomTitle(room, session.user_id)}</h1><p className="text-xs text-muted">端到端加密 · {room.purpose === "saved" ? "仅自己的设备" : `${room.members.length} 位成员`}</p></div>
      <ActionButton variant="icon" aria-label="搜索当前对话" onPress={onSearch}><IconSearch className="size-5" /></ActionButton>
    </header>{room.request_status === "pending" && room.request_role === "recipient" && <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950"><p className="min-w-0 flex-1">接受后才能回复或收发附件。</p><ActionButton variant="quiet" isDisabled={resolvingRequest} onPress={() => void resolveRequest("rejected")} className="h-9">拒绝</ActionButton><ActionButton isDisabled={resolvingRequest} onPress={() => void resolveRequest("accepted")} className="h-9">接受</ActionButton></div>}{room.request_status === "pending" && room.request_role === "requester" && requestCannotSend && <p className="border-b border-black/5 bg-white px-4 py-2 text-center text-xs text-muted">等待对方接受消息请求</p>}</div>
    <div className="min-h-0">
      {!messages.length ? <div className="grid h-full place-items-center p-8 text-center text-sm text-muted" role="status">{loading ? "正在读取消息…" : "还没有消息。发出第一条端到端加密消息。"}</div> :
        <Virtuoso key={`${room.room_id}:${anchor.generation}`} ref={timeline} className="h-full overscroll-contain"
          data={messages} firstItemIndex={anchor.index} initialTopMostItemIndex={{ index: "LAST", align: "end" }}
          computeItemKey={(_, message) => message.message_id} followOutput="auto"
          atBottomStateChange={(value) => { atBottom.current = value; }}
          atTopStateChange={(value) => { if (value) void loadOlder(); }}
          itemContent={(_, message) => <div data-message-id={message.message_id} className={jumpMessageId === message.message_id ? "rounded-2xl ring-2 ring-brand/40" : ""}><MessageRow runtime={runtime} message={message} own={message.sender === session.user_id} /></div>}
        />}
    </div>
    <div className="border-t border-black/5 bg-white px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-2">
      {composerError && <p role="alert" className="mb-2 text-xs text-red-700">{composerError}</p>}
      {files.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{files.map((file, index) => <ActionButton key={`${file.name}:${index}`} variant="quiet" onPress={() => setFiles((current) => current.filter((_, item) => item !== index))} className="h-8 shrink-0 rounded-lg bg-neutral-100 px-2.5 text-xs">{file.name} ×</ActionButton>)}</div>}
      <div className="flex items-end gap-1.5">
        <FileTrigger allowsMultiple onSelect={addFiles}><ActionButton variant="icon" aria-label="添加附件" isDisabled={requestCannotSend}><IconPaperclip className="size-5" /></ActionButton></FileTrigger>
        {!files.length && <VoiceRecorder contextId={room.room_id} disabled={sending || requestCannotSend} onRecorded={(file) => setFiles([file])} onError={setComposerError} />}
        {chatUiExperiment ? <div className="min-w-0 flex-1">
          <Suspense fallback={<div className="min-h-11 rounded-2xl bg-neutral-100" role="status">正在加载输入框…</div>}>
            <ChatUiInputExperiment {...inputInteraction} aria-label="消息输入" value={text} onChange={setText} disabled={requestCannotSend}
              ref={(input) => { composerRef.current = input instanceof HTMLTextAreaElement ? input : null; }} />
          </Suspense>
        </div> : <TextField aria-label="消息输入" value={text} onChange={setText} isDisabled={requestCannotSend} className="min-w-0 flex-1"><TextArea {...inputInteraction} ref={composerRef} rows={1} /></TextField>}
        <ActionButton variant="icon" aria-label="发送" isDisabled={sending || requestCannotSend || (!text.trim() && !files.length)} onPress={() => void submit()} className="bg-brand text-white hover:bg-brand-strong disabled:bg-neutral-200 disabled:text-neutral-400"><IconSend className="size-5" /></ActionButton>
      </div>
    </div>
  </section>;
}

export type ConversationRoomId = RoomId;
