import { describe, expect, it, vi } from "vitest";
import type { RoomEvent, RoomId, UserId } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import { EdgeChatCrossgramPlatform, type EdgeChatGatewayClient } from "../src/crossgram.js";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
}

const room = {
  room_id: "!room:example.com" as RoomId, name: null, kind: "direct", purpose: "chat", current_seq: 1, created_at: 1,
  members: [
    { user_id: "@alice:example.com" as UserId, display_name: "Alice", avatar_url: null, role: "owner" },
    { user_id: "@bob:example.com" as UserId, display_name: "Bob", avatar_url: null, role: "member" },
  ], hidden_member_ids: [], request_status: null, request_role: null, request_message_sent: false,
  home_server: "example.com", joined_seq: 0, encrypted_state: null, epoch: 1, muted_until: null, blocked_by_me: false,
} satisfies ServerRoom;

describe("EdgeChatCrossgramPlatform", () => {
  it("maps rooms and decrypted messages to CrossGram's platform shape", async () => {
    let pulled = false;
    const event = { event_id: "$one:example.com", room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 1, type: "message.text", created_at: 2_000, ciphertext: "ciphertext", metadata: { mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]),
      pull: vi.fn(async () => pulled ? [] : (pulled = true, [{ event, payload: {}, text: "hello from Bob", attachments: [] }])),
      sendText: vi.fn(async () => ({ event_id: "$two:example.com", seq: 2 })),
      sendAttachments: vi.fn(async () => ({ event_id: "$media:example.com", seq: 3, attachments: [] })),
      downloadAttachment: vi.fn(async () => new ArrayBuffer(0)),
    };
    const platform = new EdgeChatCrossgramPlatform(client, { now: () => 3_000 });
    expect((await platform.getDialogs()).dialogs[0].conversation).toMatchObject({ id: room.room_id, title: "Bob", kind: "direct" });
    const incoming = await platform.pollOnce();
    expect(incoming[0].message).toMatchObject({ id: "$one:example.com", senderId: "@bob:example.com", outgoing: false,
      content: { parts: [{ type: "text", text: "hello from Bob" }] } });
    const sent = await platform.sendMessage({}, { id: room.room_id }, { parts: [{ type: "text", text: "reply" }] });
    expect(client.sendText).toHaveBeenCalledWith(room.room_id, "reply");
    expect(sent).toMatchObject({ id: "$two:example.com", outgoing: true, nativeOrderKey: "0000000000000002" });
    const history = await platform.getHistory({}, { id: room.room_id });
    expect(history.messages.map((message) => message.id)).toEqual(["$two:example.com", "$one:example.com"]);
    platform.close();
  });

  it("maps CrossGram image/audio/file bytes onto encrypted EdgeChat attachments", async () => {
    const bytes = new TextEncoder().encode("media bytes");
    const attachment = { id: "A".repeat(32), name: "note.ogg", type: "audio/ogg", size: bytes.length,
      key: "K".repeat(43), nonce: "N".repeat(16), duration_ms: 2_500 };
    const sendAttachments = vi.fn(async () => ({ event_id: "$media:example.com", seq: 2, attachments: [attachment] }));
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]), pull: vi.fn(async () => []),
      sendText: vi.fn(async () => ({ event_id: "$text:example.com", seq: 1 })),
      sendAttachments,
      downloadAttachment: vi.fn(async () => bytes.buffer),
    };
    const platform = new EdgeChatCrossgramPlatform(client, { now: () => 4_000 });
    const message = await platform.sendMessage({}, { id: room.room_id }, { parts: [
      { type: "text", text: "caption" },
      { type: "media", media: { kind: "file", name: "note.ogg", mimeType: "audio/ogg", size: bytes.length, duration: 2.5,
        source: { size: bytes.length, async *stream() { yield bytes; } } } },
    ] });
    expect(sendAttachments).toHaveBeenCalledWith(room.room_id, [expect.objectContaining({ name: "note.ogg", type: "audio/ogg", duration_ms: 2_500 })], "caption");
    const mediaPart = message.content.parts.find((part) => part.type === "media");
    expect(mediaPart).toMatchObject({ media: { id: attachment.id, kind: "file", mimeType: "audio/ogg", duration: 2.5, voice: true } });
    if (!mediaPart || mediaPart.type !== "media") throw new Error("media part missing");
    await expect(collect(platform.downloadMedia({}, mediaPart.media, { offset: 2, limit: 5 }))).resolves.toEqual(bytes.slice(2, 7));
    platform.close();
  });
});
