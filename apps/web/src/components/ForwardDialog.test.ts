import { describe, expect, it } from "vitest";
import type { LocalMessage } from "@edgechat/db";
import { createContactMessagePayload, createMessagePayload } from "../media";
import { forwardSelectionSummary } from "./ForwardDialog";

function message(id: string, attachment = false): LocalMessage {
  const messageId = `$${id}:example.com` as const;
  const payload = createMessagePayload(messageId, attachment ? "" : id, attachment ? { id: `${id}-file`, name: `${id}.jpg`, type: "image/jpeg", size: 4, key: "key", nonce: "nonce" } : undefined);
  return {
    event_id: id, message_id: messageId, room_id: "!0123456789abcdef:example.com", seq: 1,
    sender: "@alice:example.com", device_id: "device", event_type: attachment ? "message.image" : "message.text",
    created_at: 1, ciphertext: "ciphertext", plaintext: attachment ? "" : id,
    payload: payload as unknown as Record<string, unknown>, deleted_at: null, deleted_by: null,
    delete_event_id: null, edited_at: null, edit_event_id: null, expires_at: null,
  };
}

describe("forward selection summary", () => {
  it("summarizes one text message", () => {
    expect(forwardSelectionSummary([message("hello")])).toBe("hello");
  });

  it("counts a mixed multi-message selection without exposing filenames", () => {
    expect(forwardSelectionSummary([message("one"), message("photo", true), message("two")])).toBe("已选择 3 条消息，含 1 个附件");
  });

  it("describes an encrypted contact card without exposing its identity in the forwarding dialog", () => {
    const card = message("contact");
    card.plaintext = "";
    card.payload = createContactMessagePayload("$contact:example.com", { user_id: "@alice:example.com", display_name: "Alice" }) as unknown as Record<string, unknown>;
    expect(forwardSelectionSummary([card])).toBe("联系人名片");
  });
});
