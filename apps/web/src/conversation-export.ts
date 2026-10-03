import type { LocalMessage } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { attachmentPresentation, messageAttachments, messageContacts, messageQuote, messageText, normalizeMessagePayload, type MessagePayload } from "./media";
import { translate, type Translator } from "./i18n";

const PAGE_SIZE = 500;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export type ConversationTranscriptOptions = {
  roomId: RoomId;
  roomTitle: string;
  exportedAt?: number;
  displayName: (userId: string) => string;
  loadPage: (afterSeq: number, limit: number) => Promise<LocalMessage[]>;
  write: (chunk: string) => void | Promise<void>;
  signal?: AbortSignal;
  t?: Translator;
};

export function conversationExportFilename(title: string, now = Date.now()): string {
  const safeTitle = inlineText(title).replace(/[\\/:*?"<>|]/g, "-").slice(0, 60) || "conversation";
  return `edgechat-${safeTitle}-${new Date(now).toISOString().slice(0, 10)}.txt`;
}

function sanitizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNSAFE_TEXT, "");
}

function inlineText(value: string): string {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Export cancelled", "AbortError");
}

function timestamp(value: number, t: Translator): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return t("conversationExport.timeUnknown");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function byteSize(value: number, t: Translator): string {
  if (!Number.isFinite(value) || value < 0) return t("conversationExport.sizeUnknown");
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function indent(value: string): string {
  return sanitizeText(value).split("\n").map((line) => `  ${line}`).join("\n");
}

export function formatConversationMessage(message: LocalMessage, displayName: (userId: string) => string, t: Translator = translate): string {
  let payload: MessagePayload | null = null;
  try { payload = normalizeMessagePayload((message.payload ?? {}) as MessagePayload, message.message_id); } catch { /* handled below */ }
  const originName = payload?.origin?.kind === "bot" && typeof payload.origin.display_name === "string" ? payload.origin.display_name : null;
  const senderName = inlineText(originName || displayName(message.sender)) || message.sender;
  const senderSuffix = originName ? t("conversationExport.botSender", { sender: message.sender }) : message.sender;
  const lines = [
    t("conversationExport.messageHeader", { date: timestamp(Number(message.created_at), t), name: senderName, sender: senderSuffix }),
    t("conversationExport.messageId", { id: message.message_id }),
  ];
  if (message.deleted_at !== null) lines.push(t("conversationExport.retracted"));
  else {
    try {
      if (!payload) throw new Error("Invalid local message payload");
      const quote = messageQuote(payload);
      if (quote) lines.push(t("conversationExport.quote", { name: inlineText(quote.display_name || quote.sender), content: indent(quote.text) }));
      const text = messageText(payload);
      if (text) lines.push(t("conversationExport.content", { content: indent(text) }));
      for (const contact of messageContacts(payload)) lines.push(t("conversationExport.contact", { name: inlineText(contact.contact.display_name), id: contact.contact.user_id }));
      for (const part of messageAttachments(payload)) {
        const presentation = attachmentPresentation(part.attachment);
        const kind = presentation === "image" ? t("conversationExport.kind.image") : presentation === "audio" ? t("conversationExport.kind.audio") : t("conversationExport.kind.file");
        lines.push(t("conversationExport.attachment", {
          kind, name: inlineText(part.attachment.name || t("conversationExport.unnamedAttachment")), size: byteSize(part.attachment.size, t),
        }));
      }
      if (!text && !messageContacts(payload).length && !messageAttachments(payload).length) lines.push(t("conversationExport.emptyContent"));
      if (message.edited_at !== null) lines.push(t("conversationExport.edited", { date: timestamp(Number(message.edited_at), t) }));
      if (payload.forwarded) lines.push(t("conversationExport.forwarded"));
    } catch {
      const fallback = sanitizeText(message.plaintext ?? "");
      lines.push(fallback ? t("conversationExport.content", { content: indent(fallback) }) : t("conversationExport.emptyContent"));
    }
  }
  return `${lines.join("\n")}\n\n`;
}

export async function streamConversationTranscript(options: ConversationTranscriptOptions): Promise<number> {
  const exportedAt = options.exportedAt ?? Date.now();
  const t = options.t ?? translate;
  throwIfAborted(options.signal);
  await options.write(`\uFEFF${t("conversationExport.header", { title: inlineText(options.roomTitle), room: options.roomId, date: timestamp(exportedAt, t) })}\n\n---\n\n`);
  let afterSeq = 0; let count = 0;
  while (true) {
    throwIfAborted(options.signal);
    const page = await options.loadPage(afterSeq, PAGE_SIZE);
    throwIfAborted(options.signal);
    if (page.length > PAGE_SIZE) throw new Error("本机消息分页结果超出限制");
    if (!page.length) break;
    let chunk = "";
    for (const message of page) {
      const seq = Number(message.seq);
      if (message.room_id !== options.roomId || !Number.isSafeInteger(seq) || seq <= afterSeq) throw new Error("本机消息顺序无效，导出已停止");
      chunk += formatConversationMessage(message, options.displayName, t);
      afterSeq = seq; count += 1;
    }
    throwIfAborted(options.signal);
    await options.write(chunk);
    if (page.length < PAGE_SIZE) break;
  }
  throwIfAborted(options.signal);
  await options.write(`---\n${t("conversationExport.footer", { count })}\n`);
  return count;
}
