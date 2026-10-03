import type { LocalComposerDraft } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { translate, type Translator } from "./i18n";

export const DRAFT_SAVE_DELAY_MS = 300;

export function canApplyLoadedDraft(requestedRoomId: RoomId, selectedRoomId: RoomId | null, requestedRevision: number, currentRevision: number): boolean {
  return requestedRoomId === selectedRoomId && requestedRevision === currentRevision;
}

export function composerDraftPreview(draft: LocalComposerDraft | undefined, t: Translator = translate): string | null {
  const text = draft?.text_content.trim().replace(/\s+/g, " ");
  return text ? t("draft.preview", { text }) : null;
}
