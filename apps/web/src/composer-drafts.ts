import type { LocalComposerDraft } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";

export const DRAFT_SAVE_DELAY_MS = 300;

export function canApplyLoadedDraft(requestedRoomId: RoomId, selectedRoomId: RoomId | null, requestedRevision: number, currentRevision: number): boolean {
  return requestedRoomId === selectedRoomId && requestedRevision === currentRevision;
}

export function composerDraftPreview(draft: LocalComposerDraft | undefined): string | null {
  const text = draft?.text_content.trim().replace(/\s+/g, " ");
  return text ? `草稿：${text}` : null;
}
