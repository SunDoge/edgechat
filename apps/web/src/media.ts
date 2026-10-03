import { isNamespacedMessageId, isNamespacedRoomId, isNamespacedUserId, MAX_ATTACHMENT_PLAINTEXT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES, type MessageId, type MessagePartId, type MessageReference, type UserId } from "@edgechat/protocol";

export const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_INLINE_IMAGE_PIXELS = 40_000_000;
export const MAX_INLINE_IMAGE_EDGE = 16_384;
const MAX_MESSAGE_PARTS = 32;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_MIME_LENGTH = 128;
const MAX_ATTACHMENT_SECRET_LENGTH = 512;
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ATTACHMENT_SECRET = /^[A-Za-z0-9_-]+$/;
const SAFE_PAYLOAD_MESSAGE_ID = /^\$[A-Za-z0-9_-]{1,256}:[a-z0-9.-]{1,253}$/i;
const UNSAFE_DISPLAY_TEXT = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export type AttachmentMetadata = {
  id: string;
  name: string;
  type: string;
  size: number;
  key: string;
  nonce: string;
  width?: number;
  height?: number;
  duration_ms?: number;
};

export type TextPart = { part_id: MessagePartId; kind: "text"; text: string };
export type AttachmentPart = { part_id: MessagePartId; kind: "attachment"; attachment: AttachmentMetadata };
export type ContactIdentity = { user_id: UserId; display_name: string };
export type ContactPart = { part_id: MessagePartId; kind: "contact"; contact: ContactIdentity };
export type MessagePart = TextPart | AttachmentPart | ContactPart;
export const MAX_QUOTE_TEXT_LENGTH = 2_000;
export type QuoteSnapshot = { text: string; sender: string; display_name?: string };
export type MessageRelation =
  | { type: "reply"; target: MessageReference }
  | { type: "quote"; target: MessageReference; snapshot: QuoteSnapshot };
export type MessagePayload = {
  version: 2;
  message_id: MessageId;
  parts: MessagePart[];
  deleted?: true;
  origin?: { kind: "bot"; bot_id: string; display_name: string };
  relation?: MessageRelation;
  forwarded?: true;
  saved_from?: MessageReference;
};

type LegacyMessagePayload = { text?: string; attachment?: AttachmentMetadata };

export function createMessagePayload(messageId: MessageId, text: string, attachments?: AttachmentMetadata | readonly AttachmentMetadata[], relation?: MessagePayload["relation"]): MessagePayload {
  const parts: MessagePart[] = [];
  if (text) parts.push({ part_id: crypto.randomUUID(), kind: "text", text });
  for (const attachment of attachments ? Array.isArray(attachments) ? attachments : [attachments] : []) {
    const normalized = normalizeAttachmentMetadata(attachment);
    if (!normalized) throw new Error("附件元数据无效");
    parts.push({ part_id: crypto.randomUUID(), kind: "attachment", attachment: normalized });
  }
  return normalizeMessagePayload({ version: 2, message_id: messageId, parts, ...(relation ? { relation } : {}) }, messageId);
}

export function createContactMessagePayload(messageId: MessageId, contact: ContactIdentity): MessagePayload {
  const normalized = normalizeContact(contact);
  if (!normalized) throw new Error("联系人名片无效");
  return { version: 2, message_id: messageId, parts: [{ part_id: crypto.randomUUID(), kind: "contact", contact: normalized }] };
}

export function normalizeMessagePayload(payload: MessagePayload | LegacyMessagePayload, fallbackId: string): MessagePayload {
  if ("version" in payload && payload.version === 2 && Array.isArray(payload.parts)) {
    if (typeof payload.message_id !== "string" || !SAFE_PAYLOAD_MESSAGE_ID.test(payload.message_id) || payload.parts.length > MAX_MESSAGE_PARTS) throw new Error("消息内容格式无效");
    const partIds = new Set<string>(); const attachmentIds = new Set<string>(); let attachmentBytes = 0; let attachmentCount = 0; let textBytes = 0;
    const parts = payload.parts.map((part): MessagePart => {
      if (!part || typeof part !== "object" || typeof part.part_id !== "string" || !part.part_id || part.part_id.length > 512 || partIds.has(part.part_id)) throw new Error("消息内容格式无效");
      partIds.add(part.part_id);
      if (part.kind === "text") {
        if (typeof part.text !== "string" || part.text.length > 16_000) throw new Error("消息文字无效");
        textBytes += part.text.length;
        if (textBytes > 16_000) throw new Error("消息文字过长");
        return { part_id: part.part_id as MessagePartId, kind: "text", text: part.text };
      }
      if (part.kind === "attachment") {
        const attachment = normalizeAttachmentMetadata(part.attachment);
        if (!attachment) throw new Error("附件元数据无效");
        if (attachmentIds.has(attachment.id)) throw new Error("附件引用重复");
        attachmentIds.add(attachment.id);
        attachmentCount += 1; attachmentBytes += attachment.size;
        if (attachmentCount > MAX_MESSAGE_ATTACHMENTS || attachmentBytes > MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES) throw new Error("附件数量或总大小无效");
        return { part_id: part.part_id as MessagePartId, kind: "attachment", attachment };
      }
      if (part.kind === "contact") {
        const contact = normalizeContact(part.contact);
        if (!contact) throw new Error("联系人名片无效");
        return { part_id: part.part_id as MessagePartId, kind: "contact", contact };
      }
      throw new Error("未知的消息内容类型");
    });
    return { ...payload, message_id: payload.message_id as MessageId, parts };
  }
  const legacy = payload as LegacyMessagePayload;
  const parts: MessagePart[] = [];
  if (legacy.text?.trim()) parts.push({ part_id: `${fallbackId}:text`, kind: "text", text: legacy.text.trim() });
  if (legacy.attachment) {
    const attachment = normalizeAttachmentMetadata(legacy.attachment);
    if (!attachment) throw new Error("附件元数据无效");
    parts.push({ part_id: `${fallbackId}:attachment`, kind: "attachment", attachment });
  }
  if (!SAFE_PAYLOAD_MESSAGE_ID.test(fallbackId)) throw new Error("消息标识无效");
  return { version: 2, message_id: fallbackId as MessageId, parts };
}

export function normalizeAttachmentMetadata(value: unknown): AttachmentMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Partial<AttachmentMetadata>;
  const name = typeof attachment.name === "string" ? attachment.name.trim() : "";
  const type = typeof attachment.type === "string" ? attachment.type.trim().toLowerCase() : "";
  if (typeof attachment.id !== "string" || !SAFE_ATTACHMENT_ID.test(attachment.id)
    || !name || name.length > MAX_ATTACHMENT_NAME_LENGTH || UNSAFE_DISPLAY_TEXT.test(name) || /[\\/]/u.test(name)
    || !type || type.length > MAX_ATTACHMENT_MIME_LENGTH || !type.includes("/") || /[^\x21-\x7e]/u.test(type)
    || !Number.isSafeInteger(attachment.size) || Number(attachment.size) < 1 || Number(attachment.size) > MAX_ATTACHMENT_PLAINTEXT_BYTES
    || typeof attachment.key !== "string" || attachment.key.length < 1 || attachment.key.length > MAX_ATTACHMENT_SECRET_LENGTH || !SAFE_ATTACHMENT_SECRET.test(attachment.key)
    || typeof attachment.nonce !== "string" || attachment.nonce.length < 1 || attachment.nonce.length > MAX_ATTACHMENT_SECRET_LENGTH || !SAFE_ATTACHMENT_SECRET.test(attachment.nonce)) return null;
  const hasWidth = attachment.width !== undefined; const hasHeight = attachment.height !== undefined;
  if (hasWidth !== hasHeight || (hasWidth && (!Number.isSafeInteger(attachment.width) || !Number.isSafeInteger(attachment.height)
    || Number(attachment.width) < 1 || Number(attachment.height) < 1 || Number(attachment.width) > 65_535 || Number(attachment.height) > 65_535))) return null;
  if (attachment.duration_ms !== undefined && (!Number.isSafeInteger(attachment.duration_ms) || Number(attachment.duration_ms) < 1 || Number(attachment.duration_ms) > 10 * 60_000)) return null;
  return { id: attachment.id, name, type, size: Number(attachment.size), key: attachment.key, nonce: attachment.nonce,
    ...(hasWidth ? { width: Number(attachment.width), height: Number(attachment.height) } : {}),
    ...(attachment.duration_ms !== undefined ? { duration_ms: Number(attachment.duration_ms) } : {}) };
}

export function createForwardPayload(messageId: MessageId, source: MessagePayload, attachmentAliases: readonly string[] = [], savedFrom?: MessageReference): MessagePayload {
  const attachments = messageAttachments(source);
  if (attachments.length !== attachmentAliases.length) throw new Error("转发附件缺少新的引用");
  let attachmentIndex = 0;
  const parts = source.parts.flatMap((part): MessagePart[] => {
    if (part.kind === "text") return [{ ...part, part_id: crypto.randomUUID() }];
    if (part.kind === "contact") {
      const contact = normalizeContact(part.contact);
      return contact ? [{ part_id: crypto.randomUUID(), kind: "contact", contact }] : [];
    }
    return [{ ...part, part_id: crypto.randomUUID(), attachment: { ...part.attachment, id: attachmentAliases[attachmentIndex++]! } }];
  });
  return { version: 2, message_id: messageId, parts, forwarded: true, ...(savedFrom ? { saved_from: savedFrom } : {}) };
}

export function messageText(payload: MessagePayload): string {
  return payload.parts.filter((part): part is TextPart => part.kind === "text").map((part) => part.text).join("\n");
}

export function messageAttachments(payload: MessagePayload): AttachmentPart[] {
  return payload.parts.filter((part): part is AttachmentPart => part.kind === "attachment");
}

export function assertMessageAttachmentReferences(payload: MessagePayload, eventType: string, metadata: Record<string, unknown>): void {
  const multiple = metadata.attachment_ids; const single = metadata.attachment_id;
  if (multiple !== undefined && single !== undefined) throw new Error("附件引用格式冲突");
  const declared = multiple === undefined ? single === undefined ? [] : [single] : multiple;
  if (!Array.isArray(declared) || declared.length > MAX_MESSAGE_ATTACHMENTS || declared.some((id) => typeof id !== "string") || new Set(declared).size !== declared.length) throw new Error("附件引用格式无效");
  const actual = messageAttachments(payload).map((part) => part.attachment.id);
  if ((actual.length > 0) !== (eventType === "message.file") || actual.length !== declared.length || actual.some((id, index) => id !== declared[index])) {
    throw new Error("加密附件内容与服务器引用不一致");
  }
}

export function messageContacts(payload: MessagePayload): ContactPart[] {
  return payload.parts.flatMap((part) => {
    if (part.kind !== "contact" || typeof part.part_id !== "string" || !part.part_id || part.part_id.length > 512) return [];
    const contact = normalizeContact(part.contact);
    return contact ? [{ part_id: part.part_id, kind: "contact" as const, contact }] : [];
  });
}

function normalizeContact(value: unknown): ContactIdentity | null {
  if (!value || typeof value !== "object") return null;
  const contact = value as Partial<ContactIdentity>;
  const displayName = typeof contact.display_name === "string" ? contact.display_name.trim() : "";
  if (!isNamespacedUserId(contact.user_id ?? "") || !displayName || displayName.length > 128 || /[\u0000-\u001f\u007f]/.test(displayName)) return null;
  return { user_id: contact.user_id as UserId, display_name: displayName };
}

export function quoteTextSnapshot(text: string): string {
  const normalized = text.trim().replace(/\r\n?/g, "\n");
  if (normalized.length <= MAX_QUOTE_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_QUOTE_TEXT_LENGTH - 1).trimEnd()}…`;
}

export function quoteTextForMessage(messageTextValue: string, selectedText?: string): string {
  const full = quoteTextSnapshot(messageTextValue);
  const selected = selectedText ? quoteTextSnapshot(selectedText) : "";
  return selected && full.includes(selected) ? selected : full;
}

export function messageQuote(payload: MessagePayload): QuoteSnapshot | null {
  const relation = payload.relation;
  if (relation?.type !== "quote" || !relation.snapshot || typeof relation.snapshot !== "object") return null;
  const text = typeof relation.snapshot.text === "string" ? quoteTextSnapshot(relation.snapshot.text) : "";
  const sender = typeof relation.snapshot.sender === "string" && relation.snapshot.sender.length <= 512 ? relation.snapshot.sender : "";
  const displayName = typeof relation.snapshot.display_name === "string" && relation.snapshot.display_name.trim().length <= 128
    ? relation.snapshot.display_name.trim()
    : undefined;
  return text && sender ? { text, sender, ...(displayName ? { display_name: displayName } : {}) } : null;
}

export function messageSavedFrom(payload: MessagePayload): MessageReference | null {
  const reference = payload.saved_from;
  return reference?.kind === "message" && isNamespacedMessageId(reference.message_id) && isNamespacedRoomId(reference.room_id)
    ? { kind: "message", message_id: reference.message_id, room_id: reference.room_id }
    : null;
}

export function isAudioAttachment(attachment: Pick<AttachmentMetadata, "type">): boolean {
  return attachment.type.toLowerCase().startsWith("audio/");
}

export type AttachmentPresentation = "image" | "audio" | "file";

export function attachmentPresentation(attachment: Pick<AttachmentMetadata, "type" | "size" | "width" | "height">): AttachmentPresentation {
  if (isPreviewableImage(attachment.type) && attachment.size >= 0 && attachment.size <= MAX_INLINE_IMAGE_BYTES) {
    const width = attachment.width; const height = attachment.height;
    if ((width === undefined && height === undefined)
      || (Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0
        && width! <= MAX_INLINE_IMAGE_EDGE && height! <= MAX_INLINE_IMAGE_EDGE && width! * height! <= MAX_INLINE_IMAGE_PIXELS)) return "image";
  }
  return isAudioAttachment(attachment) ? "audio" : "file";
}

export function isPreviewableImage(type: string): boolean {
  return PREVIEWABLE_IMAGE_TYPES.has(type.toLowerCase());
}

export function attachmentEventType(_file: Pick<File, "type">): "message.file" {
  return "message.file";
}

export function attachmentEventTypeForFiles(files: readonly Pick<File, "type">[]): "message.file" | "message.text" {
  return files.length ? "message.file" : "message.text";
}

export async function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (!isPreviewableImage(file.type) || file.size > MAX_INLINE_IMAGE_BYTES || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const dimensions = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 65_535 && bitmap.height <= 65_535
      ? { width: bitmap.width, height: bitmap.height }
      : null;
    bitmap.close();
    return dimensions;
  } catch {
    return null;
  }
}
