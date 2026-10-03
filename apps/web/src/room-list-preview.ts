import type { LocalRoomListActivity } from "@edgechat/db";
import { attachmentPresentation, messageAttachments, messageContacts, messageText, normalizeMessagePayload, type MessagePayload } from "./media";
import { translate, type Translator } from "./i18n";

function contentPreview(activity: LocalRoomListActivity, t: Translator): string {
  if (activity.deleted_at !== null) return t("roomPreview.retracted");
  try {
    const payload = normalizeMessagePayload(activity.payload as MessagePayload, activity.message_id);
    const text = messageText(payload).replace(/\s+/g, " ").trim();
    if (text) return text;
    const contacts = messageContacts(payload);
    if (contacts.length) return contacts.length === 1 ? t("roomPreview.contact", { name: contacts[0]!.contact.display_name }) : t("roomPreview.contacts", { count: contacts.length });
    const attachments = messageAttachments(payload);
    if (attachments.length) {
      if (attachments.every((part) => attachmentPresentation(part.attachment) === "image")) return attachments.length === 1 ? t("roomPreview.image") : t("roomPreview.images", { count: attachments.length });
      if (attachments.length === 1 && attachmentPresentation(attachments[0]!.attachment) === "audio") return attachments[0]!.attachment.duration_ms ? t("roomPreview.voice") : t("roomPreview.audio");
      if (attachments.length === 1) return t("roomPreview.file", { name: attachments[0]!.attachment.name || t("roomPreview.attachment") });
      return t("roomPreview.attachments", { count: attachments.length });
    }
  } catch {
    // A malformed local projection should not break the entire conversation list.
  }
  return activity.plaintext?.replace(/\s+/g, " ").trim() || t("roomPreview.encrypted");
}

export function formatRoomActivityPreview(
  activity: LocalRoomListActivity,
  currentUserId: string,
  group: boolean,
  displayName: (userId: string) => string,
  t: Translator = translate,
): string {
  const preview = contentPreview(activity, t);
  if (activity.outbox_status === "failed") return t("roomPreview.failed", { preview });
  if (activity.outbox_status === "sending") return t("roomPreview.sending", { preview });
  if (activity.outbox_status === "pending") return t("roomPreview.pending", { preview });
  if (activity.sender === currentUserId) return t("roomPreview.you", { preview });
  return group ? t("roomPreview.sender", { name: displayName(activity.sender), preview }) : preview;
}
