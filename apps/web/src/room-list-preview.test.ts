import { describe, expect, it } from "vitest";
import type { LocalRoomListActivity } from "@edgechat/db";
import { formatRoomActivityPreview } from "./room-list-preview";

function activity(overrides: Partial<LocalRoomListActivity> = {}): LocalRoomListActivity {
  return {
    room_id: "!roomroomroomroom:example.com",
    message_id: "$message:example.com",
    sender: "@bob:example.com",
    event_type: "message.text",
    created_at: 1,
    plaintext: "hello",
    payload: { version: 2, message_id: "$message:example.com", parts: [{ part_id: "text", kind: "text", text: "  hello\nworld " }] },
    deleted_at: null,
    outbox_status: null,
    ...overrides,
  } as LocalRoomListActivity;
}

describe("room list preview", () => {
  it("labels local delivery state without exposing it to the server", () => {
    expect(formatRoomActivityPreview(activity({ sender: "@alice:example.com", outbox_status: "failed" }), "@alice:example.com", false, String)).toBe("发送失败 · hello world");
    expect(formatRoomActivityPreview(activity({ sender: "@alice:example.com" }), "@alice:example.com", false, String)).toBe("你：hello world");
    expect(formatRoomActivityPreview(activity(), "@alice:example.com", true, () => "Bob")).toBe("Bob：hello world");
  });

  it("describes deleted messages and structured non-text parts", () => {
    expect(formatRoomActivityPreview(activity({ deleted_at: 2 }), "@alice:example.com", false, String)).toBe("消息已撤回");
    expect(formatRoomActivityPreview(activity({ payload: { version: 2, message_id: "$message:example.com", parts: [
      { part_id: "one", kind: "attachment", attachment: { id: "one", name: "1.png", type: "image/png", size: 1, key: "k", nonce: "n" } },
      { part_id: "two", kind: "attachment", attachment: { id: "two", name: "2.png", type: "image/png", size: 1, key: "k", nonce: "n" } },
    ] } }), "@alice:example.com", false, String)).toBe("2 张图片");
  });
});
