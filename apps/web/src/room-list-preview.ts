import type { LocalRoomListActivity } from "@edgechat/db";
import { attachmentPresentation, messageAttachments, messageContacts, messageText, normalizeMessagePayload, type MessagePayload } from "./media";

function contentPreview(activity: LocalRoomListActivity): string {
  if (activity.deleted_at !== null) return "消息已撤回";
  try {
    const payload = normalizeMessagePayload(activity.payload as MessagePayload, activity.message_id);
    const text = messageText(payload).replace(/\s+/g, " ").trim();
    if (text) return text;
    const contacts = messageContacts(payload);
    if (contacts.length) return contacts.length === 1 ? `联系人：${contacts[0]!.contact.display_name}` : `${contacts.length} 个联系人`;
    const attachments = messageAttachments(payload);
    if (attachments.length) {
      if (attachments.every((part) => attachmentPresentation(part.attachment) === "image")) return attachments.length === 1 ? "图片" : `${attachments.length} 张图片`;
      if (attachments.length === 1 && attachmentPresentation(attachments[0]!.attachment) === "audio") return attachments[0]!.attachment.duration_ms ? "语音消息" : "音频";
      if (attachments.length === 1) return `文件：${attachments[0]!.attachment.name || "附件"}`;
      return `${attachments.length} 个附件`;
    }
  } catch {
    // A malformed local projection should not break the entire conversation list.
  }
  return activity.plaintext?.replace(/\s+/g, " ").trim() || "加密消息";
}

export function formatRoomActivityPreview(
  activity: LocalRoomListActivity,
  currentUserId: string,
  group: boolean,
  displayName: (userId: string) => string,
): string {
  const preview = contentPreview(activity);
  if (activity.outbox_status === "failed") return `发送失败 · ${preview}`;
  if (activity.outbox_status === "sending") return `正在发送 · ${preview}`;
  if (activity.outbox_status === "pending") return `等待发送 · ${preview}`;
  if (activity.sender === currentUserId) return `你：${preview}`;
  return group ? `${displayName(activity.sender)}：${preview}` : preview;
}
