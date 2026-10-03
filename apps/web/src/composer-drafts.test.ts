import { describe, expect, it } from "vitest";
import type { LocalComposerDraft } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { createTranslator, zhHansMessages } from "./i18n";
import { canApplyLoadedDraft, composerDraftPreview } from "./composer-drafts";

const room = "!draft-room-00001:example.com" as RoomId;

describe("device-local composer drafts", () => {
  it("does not overwrite input typed while an asynchronous draft read was pending", () => {
    expect(canApplyLoadedDraft(room, room, 4, 5)).toBe(false);
    expect(canApplyLoadedDraft(room, "!another-room-001:example.com" as RoomId, 4, 4)).toBe(false);
    expect(canApplyLoadedDraft(room, room, 4, 4)).toBe(true);
  });

  it("uses concise human-facing room list copy", () => {
    const draft = { room_id: room, text_content: "  明天\n再确认  ", mode: "message", target_message_id: null, quote_text: null, updated_at: 1 } satisfies LocalComposerDraft;
    expect(composerDraftPreview(draft)).toBe("草稿：明天 再确认");
    const english = createTranslator({ ...zhHansMessages, "draft.preview": "Draft: {text}" });
    expect(composerDraftPreview(draft, english)).toBe("Draft: 明天 再确认");
    expect(composerDraftPreview({ ...draft, text_content: "   " })).toBeNull();
  });
});
