import { describe, expect, it } from "vitest";
import type { LocalMessage } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { conversationExportFilename, formatConversationMessage, streamConversationTranscript } from "./conversation-export";

const room = "!roomroomroomroom:example.com" as RoomId;
function message(seq: number, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    event_id: `event-${seq}`, message_id: `$message-${seq}:example.com`, room_id: room, seq,
    sender: "@alice:example.com", device_id: "device", event_type: "message.text", created_at: new Date(2026, 9, 3, 9, 5, seq).getTime(),
    ciphertext: "server ciphertext", plaintext: "hello", payload: { version: 2, message_id: `$message-${seq}:example.com`, parts: [{ part_id: "text", kind: "text", text: "hello" }] },
    deleted_at: null, deleted_by: null, delete_event_id: null, edited_at: null, edit_event_id: null, expires_at: null,
    ...overrides,
  } as LocalMessage;
}

describe("conversation transcript export", () => {
  it("formats readable content without attachment keys, ciphertext or deleted plaintext", () => {
    const formatted = formatConversationMessage(message(1, { payload: { version: 2, message_id: "$message-1:example.com", parts: [
      { part_id: "text", kind: "text", text: "caption" },
      { part_id: "image", kind: "attachment", attachment: { id: "opaque", name: "photo.png", type: "image/png", size: 2048, key: "secret-key", nonce: "secret-nonce" } },
    ] } }), () => "Alice");
    expect(formatted).toContain("caption"); expect(formatted).toContain("图片：photo.png（2.0 KiB；文件内容未包含）");
    expect(formatted).not.toContain("secret-key"); expect(formatted).not.toContain("server ciphertext"); expect(formatted).not.toContain("opaque");
    const deleted = formatConversationMessage(message(2, { plaintext: "must stay gone", deleted_at: 2 }), () => "Alice");
    expect(deleted).toContain("[消息已撤回]"); expect(deleted).not.toContain("must stay gone");
  });

  it("streams bounded ascending pages and reports the exported count", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => message(index + 1)); const chunks: string[] = []; const calls: number[] = [];
    const count = await streamConversationTranscript({ roomId: room, roomTitle: "测试 / 对话", exportedAt: new Date(2026, 9, 3, 12).getTime(), displayName: () => "Alice", write: (chunk) => { chunks.push(chunk); }, loadPage: async (after, limit) => {
      calls.push(after); return rows.filter((item) => Number(item.seq) > after).slice(0, limit);
    } });
    expect(count).toBe(501); expect(calls).toEqual([0, 500]); expect(chunks).toHaveLength(4);
    expect(chunks.join("")).toContain("共导出 501 条本机消息");
    expect(conversationExportFilename("测试 / 对话", new Date("2026-10-03T00:00:00Z").getTime())).toBe("edgechat-测试 - 对话-2026-10-03.txt");
  });

  it("fails closed on a duplicate or cross-room page", async () => {
    await expect(streamConversationTranscript({ roomId: room, roomTitle: "test", displayName: String, write: () => undefined, loadPage: async () => [message(1), message(1)] })).rejects.toThrow("消息顺序无效");
  });

  it("can stop a long export between bounded pages", async () => {
    const controller = new AbortController(); let calls = 0;
    await expect(streamConversationTranscript({ roomId: room, roomTitle: "test", signal: controller.signal, displayName: String, write: () => undefined, loadPage: async () => {
      calls += 1; controller.abort(); return Array.from({ length: 500 }, (_, index) => message(index + 1));
    } })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("attributes personal integration messages to their encrypted Bot origin", () => {
    const formatted = formatConversationMessage(message(3, { payload: { version: 2, message_id: "$message-3:example.com", origin: { kind: "bot", bot_id: "weather", display_name: "Weather" }, parts: [{ part_id: "text", kind: "text", text: "rain" }] } }), () => "Alice");
    expect(formatted).toContain("Weather (Bot · @alice:example.com)");
  });
});
