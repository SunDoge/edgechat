import { isNamespacedMessageId, isNamespacedRoomId, isNamespacedUserId, MAX_ATTACHMENT_PLAINTEXT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES, type MessageId, type MessagePartId, type MessageReference, type UserId } from "@edgechat/protocol";
import { DiagnosticError } from "@edgechat/client-storage";

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
export const MAX_EMBEDDED_IMAGE_PREVIEW_BYTES = 8 * 1024;
export const MAX_MESSAGE_EMBEDDED_IMAGE_PREVIEW_BYTES = 40 * 1024;
const MAX_EMBEDDED_IMAGE_PREVIEW_EDGE = 256;
const MAX_MESSAGE_PARTS = 32;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_MIME_LENGTH = 128;
const MAX_ATTACHMENT_SECRET_LENGTH = 512;
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ATTACHMENT_SECRET = /^[A-Za-z0-9_-]+$/;
const SAFE_BOT_ID = /^bot_[A-Za-z0-9_-]{16,64}$/;
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
  preview?: EmbeddedImagePreview;
};

export type EmbeddedImagePreview = {
  type: "image/webp" | "image/jpeg";
  data: string;
  width: number;
  height: number;
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
    if (!normalized) throw new DiagnosticError("ATTACHMENT_METADATA_INVALID");
    parts.push({ part_id: crypto.randomUUID(), kind: "attachment", attachment: normalized });
  }
  return normalizeMessagePayload({ version: 2, message_id: messageId, parts, ...(relation ? { relation } : {}) }, messageId);
}

export function createContactMessagePayload(messageId: MessageId, contact: ContactIdentity): MessagePayload {
  const normalized = normalizeContact(contact);
  if (!normalized) throw new DiagnosticError("CONTACT_CARD_INVALID");
  return normalizeMessagePayload({ version: 2, message_id: messageId, parts: [{ part_id: crypto.randomUUID(), kind: "contact", contact: normalized }] }, messageId);
}

export function normalizeMessagePayload(payload: MessagePayload | LegacyMessagePayload, fallbackId: string): MessagePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new DiagnosticError("MESSAGE_PAYLOAD_INVALID");
  if ("version" in payload && payload.version === 2 && Array.isArray(payload.parts)) {
    if (!isNamespacedMessageId(payload.message_id) || payload.message_id !== fallbackId) throw new DiagnosticError("MESSAGE_ID_EVENT_MISMATCH");
    if (payload.parts.length > MAX_MESSAGE_PARTS) throw new DiagnosticError("MESSAGE_PAYLOAD_INVALID");
    const partIds = new Set<string>(); const attachmentIds = new Set<string>(); let attachmentBytes = 0; let attachmentCount = 0; let previewBytes = 0; let textBytes = 0;
    const parts = payload.parts.map((part): MessagePart => {
      if (!part || typeof part !== "object" || typeof part.part_id !== "string" || !/^[A-Za-z0-9_:$.-]{1,512}$/.test(part.part_id) || partIds.has(part.part_id)) throw new DiagnosticError("MESSAGE_PAYLOAD_INVALID");
      partIds.add(part.part_id);
      if (part.kind === "text") {
        if (typeof part.text !== "string" || part.text.length > 16_000) throw new DiagnosticError("MESSAGE_TEXT_INVALID");
        textBytes += part.text.length;
        if (textBytes > 16_000) throw new DiagnosticError("MESSAGE_TEXT_LIMIT_EXCEEDED");
        return { part_id: part.part_id as MessagePartId, kind: "text", text: part.text };
      }
      if (part.kind === "attachment") {
        const attachment = normalizeAttachmentMetadata(part.attachment);
        if (!attachment) throw new DiagnosticError("ATTACHMENT_METADATA_INVALID");
        if (attachmentIds.has(attachment.id)) throw new DiagnosticError("ATTACHMENT_REFERENCE_DUPLICATE");
        attachmentIds.add(attachment.id);
        attachmentCount += 1; attachmentBytes += attachment.size;
        if (attachmentCount > MAX_MESSAGE_ATTACHMENTS || attachmentBytes > MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES) throw new DiagnosticError("MESSAGE_ATTACHMENT_LIMIT_EXCEEDED");
        previewBytes += attachment.preview ? embeddedImagePreviewByteLength(attachment.preview) : 0;
        if (previewBytes > MAX_MESSAGE_EMBEDDED_IMAGE_PREVIEW_BYTES) throw new DiagnosticError("MESSAGE_PREVIEW_LIMIT_EXCEEDED");
        return { part_id: part.part_id as MessagePartId, kind: "attachment", attachment };
      }
      if (part.kind === "contact") {
        const contact = normalizeContact(part.contact);
        if (!contact) throw new DiagnosticError("CONTACT_CARD_INVALID");
        return { part_id: part.part_id as MessagePartId, kind: "contact", contact };
      }
      throw new DiagnosticError("MESSAGE_PART_KIND_UNKNOWN");
    });
    const relation = payload.relation === undefined ? undefined : normalizeMessageRelation(payload.relation);
    if (payload.relation !== undefined && !relation) throw new DiagnosticError("MESSAGE_RELATION_INVALID");
    const savedFrom = payload.saved_from === undefined ? undefined : normalizeMessageReference(payload.saved_from);
    if (payload.saved_from !== undefined && !savedFrom) throw new DiagnosticError("MESSAGE_SAVED_SOURCE_INVALID");
    const origin = payload.origin === undefined ? undefined : normalizeBotOrigin(payload.origin);
    if (payload.origin !== undefined && !origin) throw new DiagnosticError("MESSAGE_ORIGIN_INVALID");
    if (payload.forwarded !== undefined && payload.forwarded !== true) throw new DiagnosticError("MESSAGE_FORWARDED_FLAG_INVALID");
    if (payload.deleted !== undefined && payload.deleted !== true) throw new DiagnosticError("MESSAGE_DELETED_FLAG_INVALID");
    return {
      version: 2, message_id: payload.message_id, parts,
      ...(payload.deleted === true ? { deleted: true as const } : {}),
      ...(origin ? { origin } : {}), ...(relation ? { relation } : {}),
      ...(payload.forwarded === true ? { forwarded: true as const } : {}),
      ...(savedFrom ? { saved_from: savedFrom } : {}),
    };
  }
  const legacy = payload as LegacyMessagePayload;
  const parts: MessagePart[] = [];
  if (legacy.text !== undefined && typeof legacy.text !== "string") throw new DiagnosticError("MESSAGE_TEXT_INVALID");
  const legacyText = legacy.text?.trim() ?? "";
  if (legacyText.length > 16_000) throw new DiagnosticError("MESSAGE_TEXT_LIMIT_EXCEEDED");
  if (legacyText) parts.push({ part_id: `${fallbackId}:text`, kind: "text", text: legacyText });
  if (legacy.attachment) {
    const attachment = normalizeAttachmentMetadata(legacy.attachment);
    if (!attachment) throw new DiagnosticError("ATTACHMENT_METADATA_INVALID");
    parts.push({ part_id: `${fallbackId}:attachment`, kind: "attachment", attachment });
  }
  if (!isNamespacedMessageId(fallbackId)) throw new DiagnosticError("MESSAGE_ID_INVALID");
  return { version: 2, message_id: fallbackId as MessageId, parts };
}

function normalizeMessageReference(value: unknown): MessageReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Partial<MessageReference>;
  return reference.kind === "message" && isNamespacedMessageId(reference.message_id ?? "") && isNamespacedRoomId(reference.room_id ?? "")
    ? { kind: "message", message_id: reference.message_id as MessageId, room_id: reference.room_id as MessageReference["room_id"] }
    : null;
}

function normalizeMessageRelation(value: unknown): MessageRelation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const relation = value as Partial<MessageRelation>;
  const target = normalizeMessageReference(relation.target);
  if (!target) return null;
  if (relation.type === "reply") return { type: "reply", target };
  if (relation.type !== "quote" || !relation.snapshot || typeof relation.snapshot !== "object" || Array.isArray(relation.snapshot)) return null;
  const snapshot = relation.snapshot as Partial<QuoteSnapshot>;
  const text = typeof snapshot.text === "string" ? snapshot.text.trim().replace(/\r\n?/g, "\n") : "";
  const displayName = typeof snapshot.display_name === "string" ? snapshot.display_name.trim() : undefined;
  if (!text || text.length > MAX_QUOTE_TEXT_LENGTH || !isNamespacedUserId(snapshot.sender ?? "")
    || (displayName !== undefined && (!displayName || displayName.length > 128 || UNSAFE_DISPLAY_TEXT.test(displayName)))) return null;
  return { type: "quote", target, snapshot: { text, sender: snapshot.sender!, ...(displayName ? { display_name: displayName } : {}) } };
}

function normalizeBotOrigin(value: unknown): MessagePayload["origin"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const origin = value as Partial<NonNullable<MessagePayload["origin"]>>;
  const displayName = typeof origin.display_name === "string" ? origin.display_name.trim() : "";
  if (origin.kind !== "bot" || typeof origin.bot_id !== "string" || !SAFE_BOT_ID.test(origin.bot_id)
    || !displayName || displayName.length > 60 || UNSAFE_DISPLAY_TEXT.test(displayName)) return null;
  return { kind: "bot", bot_id: origin.bot_id, display_name: displayName };
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
  const preview = attachment.preview === undefined ? undefined : normalizeEmbeddedImagePreview(attachment.preview);
  if (attachment.preview !== undefined && (!preview || !isPreviewableImage(type))) return null;
  return { id: attachment.id, name, type, size: Number(attachment.size), key: attachment.key, nonce: attachment.nonce,
    ...(hasWidth ? { width: Number(attachment.width), height: Number(attachment.height) } : {}),
    ...(attachment.duration_ms !== undefined ? { duration_ms: Number(attachment.duration_ms) } : {}), ...(preview ? { preview } : {}) };
}

function normalizeEmbeddedImagePreview(value: unknown): EmbeddedImagePreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const preview = value as Partial<EmbeddedImagePreview>;
  if ((preview.type !== "image/webp" && preview.type !== "image/jpeg")
    || typeof preview.data !== "string" || !/^[A-Za-z0-9_-]+$/.test(preview.data) || preview.data.length % 4 === 1
    || !Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height)
    || Number(preview.width) < 1 || Number(preview.height) < 1
    || Number(preview.width) > MAX_EMBEDDED_IMAGE_PREVIEW_EDGE || Number(preview.height) > MAX_EMBEDDED_IMAGE_PREVIEW_EDGE) return null;
  const normalized = { type: preview.type, data: preview.data, width: Number(preview.width), height: Number(preview.height) };
  return embeddedImagePreviewByteLength(normalized) <= MAX_EMBEDDED_IMAGE_PREVIEW_BYTES ? normalized : null;
}

export function embeddedImagePreviewByteLength(preview: Pick<EmbeddedImagePreview, "data">): number {
  return Math.floor(preview.data.length * 3 / 4);
}

export function embeddedImagePreviewUrl(preview: EmbeddedImagePreview): string {
  const padding = "=".repeat((4 - preview.data.length % 4) % 4);
  return `data:${preview.type};base64,${preview.data.replace(/-/g, "+").replace(/_/g, "/")}${padding}`;
}

export function createForwardPayload(messageId: MessageId, source: MessagePayload, attachmentAliases: readonly string[] = [], savedFrom?: MessageReference): MessagePayload {
  const attachments = messageAttachments(source);
  if (attachments.length !== attachmentAliases.length) throw new DiagnosticError("FORWARD_ATTACHMENT_ALIAS_MISSING");
  let attachmentIndex = 0;
  const parts = source.parts.flatMap((part): MessagePart[] => {
    if (part.kind === "text") return [{ ...part, part_id: crypto.randomUUID() }];
    if (part.kind === "contact") {
      const contact = normalizeContact(part.contact);
      return contact ? [{ part_id: crypto.randomUUID(), kind: "contact", contact }] : [];
    }
    return [{ ...part, part_id: crypto.randomUUID(), attachment: { ...part.attachment, id: attachmentAliases[attachmentIndex++]! } }];
  });
  return normalizeMessagePayload({ version: 2, message_id: messageId, parts, forwarded: true, ...(savedFrom ? { saved_from: savedFrom } : {}) }, messageId);
}

export function messageText(payload: MessagePayload): string {
  return payload.parts.filter((part): part is TextPart => part.kind === "text").map((part) => part.text).join("\n");
}

export function messageAttachments(payload: MessagePayload): AttachmentPart[] {
  return payload.parts.filter((part): part is AttachmentPart => part.kind === "attachment");
}

export function assertMessageAttachmentReferences(payload: MessagePayload, eventType: string, metadata: Record<string, unknown>): void {
  const multiple = metadata.attachment_ids; const single = metadata.attachment_id;
  if (multiple !== undefined && single !== undefined) throw new DiagnosticError("ATTACHMENT_REFERENCE_FORMAT_CONFLICT");
  const declared = multiple === undefined ? single === undefined ? [] : [single] : multiple;
  if (!Array.isArray(declared) || declared.length > MAX_MESSAGE_ATTACHMENTS || declared.some((id) => typeof id !== "string") || new Set(declared).size !== declared.length) throw new DiagnosticError("ATTACHMENT_REFERENCES_INVALID");
  const actual = messageAttachments(payload).map((part) => part.attachment.id);
  if ((actual.length > 0) !== (eventType === "message.file") || actual.length !== declared.length || actual.some((id, index) => id !== declared[index])) {
    throw new DiagnosticError("ATTACHMENT_REFERENCE_ENVELOPE_MISMATCH");
  }
}

export function assertMessageEnvelope(payload: MessagePayload, event: { event_id: string; room_id: string; type: string; metadata: Record<string, unknown> }): void {
  if (payload.message_id !== event.event_id || payload.deleted || !payload.parts.length) throw new DiagnosticError("MESSAGE_EVENT_ENVELOPE_MISMATCH");
  const attachments = messageAttachments(payload); const contacts = messageContacts(payload);
  if (event.type === "message.text") {
    if (attachments.length || contacts.length) throw new DiagnosticError("TEXT_MESSAGE_PARTS_INVALID");
  } else if (event.type === "message.file") {
    if (!attachments.length || contacts.length) throw new DiagnosticError("ATTACHMENT_MESSAGE_PARTS_INVALID");
  } else if (event.type === "message.contact") {
    if (!contacts.length || contacts.length !== payload.parts.length) throw new DiagnosticError("CONTACT_MESSAGE_PARTS_INVALID");
  } else throw new DiagnosticError("VISIBLE_MESSAGE_TYPE_UNSUPPORTED");
  if (payload.relation?.target.room_id !== undefined && payload.relation.target.room_id !== event.room_id) throw new DiagnosticError("MESSAGE_RELATION_ROOM_MISMATCH");
  if (payload.saved_from && !payload.forwarded) throw new DiagnosticError("MESSAGE_SAVED_SOURCE_FORWARD_FLAG_MISSING");
  const senderKind = event.metadata.sender_kind; const botId = event.metadata.bot_id;
  if (payload.origin) {
    if (senderKind !== "bot" || botId !== payload.origin.bot_id) throw new DiagnosticError("BOT_ORIGIN_AUTHORIZATION_MISMATCH");
  } else if (senderKind !== undefined || botId !== undefined) throw new DiagnosticError("BOT_ORIGIN_UNAUTHENTICATED");
  assertMessageAttachmentReferences(payload, event.type, event.metadata);
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
  if (!isNamespacedUserId(contact.user_id ?? "") || !displayName || displayName.length > 128 || UNSAFE_DISPLAY_TEXT.test(displayName)) return null;
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
  return normalizeMessageReference(payload.saved_from);
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

type PreparedImageMetadata = { dimensions: { width: number; height: number } | null; preview: EmbeddedImagePreview | null };

function canvasBlob(canvas: HTMLCanvasElement, type: EmbeddedImagePreview["type"], quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob?.type === type ? blob : null), type, quality));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export async function prepareImageMetadata(file: Blob, previewBudget = MAX_EMBEDDED_IMAGE_PREVIEW_BYTES): Promise<PreparedImageMetadata> {
  if (!isPreviewableImage(file.type) || file.size > MAX_INLINE_IMAGE_BYTES || typeof createImageBitmap !== "function") {
    return { dimensions: null, preview: null };
  }
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const dimensions = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 65_535 && bitmap.height <= 65_535
      ? { width: bitmap.width, height: bitmap.height }
      : null;
    if (!dimensions || previewBudget < 256 || bitmap.width > MAX_INLINE_IMAGE_EDGE || bitmap.height > MAX_INLINE_IMAGE_EDGE
      || bitmap.width * bitmap.height > MAX_INLINE_IMAGE_PIXELS) return { dimensions, preview: null };
    const allowedBytes = Math.min(previewBudget, MAX_EMBEDDED_IMAGE_PREVIEW_BYTES);
    for (const edge of [MAX_EMBEDDED_IMAGE_PREVIEW_EDGE, 192, 128]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale)); const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return { dimensions, preview: null };
      context.drawImage(bitmap, 0, 0, width, height);
      for (const [type, quality] of [["image/webp", 0.56], ["image/webp", 0.4], ["image/jpeg", 0.48], ["image/jpeg", 0.34]] as const) {
        const blob = await canvasBlob(canvas, type, quality);
        if (!blob || blob.size > allowedBytes) continue;
        return { dimensions, preview: { type, data: base64Url(new Uint8Array(await blob.arrayBuffer())), width, height } };
      }
    }
    return { dimensions, preview: null };
  } catch {
    return { dimensions: null, preview: null };
  } finally {
    bitmap?.close();
  }
}
