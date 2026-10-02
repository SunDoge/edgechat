import { isNamespacedMessageId, isNamespacedRoomId, isNamespacedUserId, type MessageId, type MessagePartId, type MessageReference, type UserId } from "@edgechat/protocol";

export const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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
export type AttachmentPart = { part_id: MessagePartId; kind: "image" | "voice" | "file"; attachment: AttachmentMetadata };
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
    parts.push({ part_id: crypto.randomUUID(), kind: attachmentKind(attachment), attachment });
  }
  return { version: 2, message_id: messageId, parts, ...(relation ? { relation } : {}) };
}

export function createContactMessagePayload(messageId: MessageId, contact: ContactIdentity): MessagePayload {
  const normalized = normalizeContact(contact);
  if (!normalized) throw new Error("联系人名片无效");
  return { version: 2, message_id: messageId, parts: [{ part_id: crypto.randomUUID(), kind: "contact", contact: normalized }] };
}

export function normalizeMessagePayload(payload: MessagePayload | LegacyMessagePayload, fallbackId: string): MessagePayload {
  if ("version" in payload && payload.version === 2 && Array.isArray(payload.parts)) return payload;
  const legacy = payload as LegacyMessagePayload;
  const parts: MessagePart[] = [];
  if (legacy.text?.trim()) parts.push({ part_id: `${fallbackId}:text`, kind: "text", text: legacy.text.trim() });
  if (legacy.attachment) parts.push({ part_id: `${fallbackId}:attachment`, kind: attachmentKind(legacy.attachment), attachment: legacy.attachment });
  return { version: 2, message_id: fallbackId as MessageId, parts };
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
  return payload.parts.filter((part): part is AttachmentPart => part.kind === "image" || part.kind === "voice" || part.kind === "file");
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

export function isVoiceAttachment(attachment: Pick<AttachmentMetadata, "type" | "duration_ms">): boolean {
  return attachment.type.toLowerCase().startsWith("audio/") && Number.isFinite(attachment.duration_ms)
    && Number(attachment.duration_ms) > 0 && Number(attachment.duration_ms) <= 10 * 60_000;
}

function attachmentKind(attachment: AttachmentMetadata): AttachmentPart["kind"] {
  return isPreviewableImage(attachment.type) ? "image" : isVoiceAttachment(attachment) ? "voice" : "file";
}

export function isPreviewableImage(type: string): boolean {
  return PREVIEWABLE_IMAGE_TYPES.has(type.toLowerCase());
}

export function attachmentEventType(file: Pick<File, "type">): "message.file" | "message.image" {
  return isPreviewableImage(file.type) ? "message.image" : "message.file";
}

export function attachmentEventTypeForFiles(files: readonly Pick<File, "type">[]): "message.file" | "message.image" | "message.text" {
  if (!files.length) return "message.text";
  return files.every((file) => isPreviewableImage(file.type)) ? "message.image" : "message.file";
}

export async function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (!isPreviewableImage(file.type) || typeof createImageBitmap !== "function") return null;
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
