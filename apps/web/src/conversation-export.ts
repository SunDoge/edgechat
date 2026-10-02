import type { LocalMessage } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { messageAttachments, messageContacts, messageQuote, messageText, normalizeMessagePayload, type MessagePayload } from "./media";

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

function timestamp(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function byteSize(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function indent(value: string): string {
  return sanitizeText(value).split("\n").map((line) => `  ${line}`).join("\n");
}

export function formatConversationMessage(message: LocalMessage, displayName: (userId: string) => string): string {
  let payload: MessagePayload | null = null;
  try { payload = normalizeMessagePayload((message.payload ?? {}) as MessagePayload, message.message_id); } catch { /* handled below */ }
  const originName = payload?.origin?.kind === "bot" && typeof payload.origin.display_name === "string" ? payload.origin.display_name : null;
  const senderName = inlineText(originName || displayName(message.sender)) || message.sender;
  const senderSuffix = originName ? `Bot · ${message.sender}` : message.sender;
  const lines = [`[${timestamp(Number(message.created_at))}] ${senderName} (${senderSuffix})`, `消息 ID：${message.message_id}`];
  if (message.deleted_at !== null) lines.push("内容：[消息已撤回]");
  else {
    try {
      if (!payload) throw new Error("Invalid local message payload");
      const quote = messageQuote(payload);
      if (quote) lines.push(`引用 ${inlineText(quote.display_name || quote.sender)}：\n${indent(quote.text)}`);
      const text = messageText(payload);
      if (text) lines.push(`内容：\n${indent(text)}`);
      for (const contact of messageContacts(payload)) lines.push(`联系人：${inlineText(contact.contact.display_name)} (${contact.contact.user_id})`);
      for (const part of messageAttachments(payload)) {
        const kind = part.kind === "image" ? "图片" : part.kind === "voice" ? "语音" : "文件";
        lines.push(`${kind}：${inlineText(part.attachment.name || "未命名附件")}（${byteSize(part.attachment.size)}；文件内容未包含）`);
      }
      if (!text && !messageContacts(payload).length && !messageAttachments(payload).length) lines.push("内容：[本机没有可导出的消息内容]");
      if (message.edited_at !== null) lines.push(`状态：已编辑（${timestamp(Number(message.edited_at))}）`);
      if (payload.forwarded) lines.push("状态：已转发");
    } catch {
      const fallback = sanitizeText(message.plaintext ?? "");
      lines.push(fallback ? `内容：\n${indent(fallback)}` : "内容：[本机没有可导出的消息内容]");
    }
  }
  return `${lines.join("\n")}\n\n`;
}

export async function streamConversationTranscript(options: ConversationTranscriptOptions): Promise<number> {
  const exportedAt = options.exportedAt ?? Date.now();
  throwIfAborted(options.signal);
  await options.write(`\uFEFFEdgeChat 本机聊天记录\n对话：${inlineText(options.roomTitle)}\n房间：${options.roomId}\n导出时间：${timestamp(exportedAt)}\n\n范围说明：仅包含这台设备当前已索引且未隐藏的消息。已撤回内容不会恢复；附件只列出名称和大小，不会下载或写入文件。\n安全提醒：此文件包含未加密的聊天内容，请妥善保管。\n\n---\n\n`);
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
      chunk += formatConversationMessage(message, options.displayName);
      afterSeq = seq; count += 1;
    }
    throwIfAborted(options.signal);
    await options.write(chunk);
    if (page.length < PAGE_SIZE) break;
  }
  throwIfAborted(options.signal);
  await options.write(`---\n共导出 ${count} 条本机消息。\n`);
  return count;
}
