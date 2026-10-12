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
    const event = { event_id: "$one12345:example.com", room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 1, type: "message.text", created_at: 2_000, ciphertext: "ciphertext", metadata: { mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    const replyToId = "$target123:example.com" as const;
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]),
      pull: vi.fn(async () => pulled ? [] : (pulled = true, [{ event, payload: {}, text: "hello from Bob", attachments: [], replyToId }])),
      acknowledgeDeliveries: vi.fn(async () => undefined),
      sendText: vi.fn(async () => ({ event_id: "$two12345:example.com" as const, seq: 2 })),
      sendAttachments: vi.fn(async () => ({ event_id: "$media123:example.com" as const, seq: 3, attachments: [] })),
      deleteMessage: vi.fn(async () => ({ event_id: "$delete12:example.com" as const, seq: 4 })),
      editMessage: vi.fn(async () => ({ event_id: "$edit1234:example.com" as const, seq: 5 })),
      setMessageReaction: vi.fn(async () => ({ event_id: "$react123:example.com" as const, seq: 6 })),
      reactionContext: vi.fn(() => ({ available: [], reactions: [], maxSelected: 1 as const })),
      downloadAttachment: vi.fn(async () => new ArrayBuffer(0)),
    };
    const platform = new EdgeChatCrossgramPlatform(client, { now: () => 3_000 });
    expect((await platform.getDialogs()).dialogs[0].conversation).toMatchObject({ id: room.room_id, title: "Bob", kind: "direct" });
    const incoming = await platform.pollOnce();
    expect(incoming[0]?.type).toBe("message");
    if (incoming[0]?.type !== "message") throw new Error("message event missing");
    expect(incoming[0].message).toMatchObject({ id: "$one12345:example.com", senderId: "@bob:example.com", outgoing: false,
      content: { parts: [{ type: "text", text: "hello from Bob" }] }, replyToId });
    const sent = await platform.sendMessage({}, { id: room.room_id }, { parts: [{ type: "text", text: "reply" }], replyToId: event.event_id });
    expect(client.sendText).toHaveBeenCalledWith(room.room_id, "reply", { replyToId: event.event_id });
    expect(sent).toMatchObject({ id: "$two12345:example.com", outgoing: true, nativeOrderKey: "0000000000000002", replyToId: event.event_id });
    const edited = await platform.editMessage({}, { conversationId: room.room_id, messageId: sent.id, targetId: sent.id },
      { parts: [{ type: "text", text: "edited reply" }] });
    expect(client.editMessage).toHaveBeenCalledWith(room.room_id, sent.id, "edited reply");
    expect(edited).toMatchObject({ id: sent.id, content: { parts: [{ type: "text", text: "edited reply" }] } });
    const history = await platform.getHistory({}, { id: room.room_id });
    expect(history.messages.map((message) => message.id)).toEqual(["$two12345:example.com", "$one12345:example.com"]);
    platform.close();
  });

  it("maps CrossGram image/audio/file bytes onto encrypted EdgeChat attachments", async () => {
    const bytes = new TextEncoder().encode("media bytes");
    const attachment = { id: "A".repeat(32), name: "note.ogg", type: "audio/ogg", size: bytes.length,
      key: "K".repeat(43), nonce: "N".repeat(16), duration_ms: 2_500 };
    const sendAttachments = vi.fn(async () => ({ event_id: "$media123:example.com" as const, seq: 2, attachments: [attachment] }));
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]), pull: vi.fn(async () => []),
      acknowledgeDeliveries: vi.fn(async () => undefined),
      sendText: vi.fn(async () => ({ event_id: "$text1234:example.com" as const, seq: 1 })),
      sendAttachments,
      deleteMessage: vi.fn(async () => ({ event_id: "$delete12:example.com" as const, seq: 3 })),
      editMessage: vi.fn(async () => ({ event_id: "$edit1234:example.com" as const, seq: 4 })),
      setMessageReaction: vi.fn(async () => ({ event_id: "$react123:example.com" as const, seq: 5 })),
      reactionContext: vi.fn(() => ({ available: [], reactions: [], maxSelected: 1 as const })),
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

  it("acknowledges a durable delivery only after the subscriber commits it", async () => {
    const event = { event_id: "$durable:example.com", room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 1, type: "message.text", created_at: 2_000, ciphertext: "ciphertext", metadata: { mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    let acknowledged = false;
    const acknowledgeDeliveries = vi.fn(async (eventIds: readonly string[]) => {
      expect(eventIds).toEqual([event.event_id]);
      acknowledged = true;
    });
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]),
      pull: vi.fn(async () => acknowledged ? [] : [{ event, payload: {}, text: "retry me", attachments: [] }]),
      acknowledgeDeliveries,
      sendText: vi.fn(async () => ({ event_id: "$text1234:example.com" as const, seq: 2 })),
      sendAttachments: vi.fn(async () => ({ event_id: "$media123:example.com" as const, seq: 3, attachments: [] })),
      deleteMessage: vi.fn(async () => ({ event_id: "$delete12:example.com" as const, seq: 4 })),
      editMessage: vi.fn(async () => ({ event_id: "$edit1234:example.com" as const, seq: 5 })),
      setMessageReaction: vi.fn(async () => ({ event_id: "$react123:example.com" as const, seq: 6 })),
      reactionContext: vi.fn(() => ({ available: [], reactions: [], maxSelected: 1 as const })),
      downloadAttachment: vi.fn(async () => new ArrayBuffer(0)),
    };
    let reportPollError!: (error: unknown) => void;
    const firstError = new Promise<unknown>((resolve) => { reportPollError = resolve; });
    const platform = new EdgeChatCrossgramPlatform(client, { pollIntervalMs: 60_000, onPollError: reportPollError });
    let attempts = 0;
    const unsubscribe = await platform.subscribe({}, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database commit failed");
    });

    await expect(firstError).resolves.toMatchObject({ message: "database commit failed" });
    expect(acknowledgeDeliveries).not.toHaveBeenCalled();
    await expect(platform.pollOnce()).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
    expect(acknowledgeDeliveries).toHaveBeenCalledOnce();

    await unsubscribe();
    platform.close();
  });

  it("maps immutable EdgeChat retractions to CrossGram delete operations and events", async () => {
    const targetMessageId = "$target123:example.com" as const;
    const deletionEvent = { event_id: "$delete12:example.com", room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 2, type: "message.delete", created_at: 5_000, ciphertext: "ciphertext", metadata: { target_event_id: targetMessageId, mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    const deleteMessage = vi.fn(async () => ({ event_id: "$delete34:example.com" as const, seq: 3 }));
    let pulled = false;
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]),
      pull: vi.fn(async () => pulled ? [] : (pulled = true, [{ event: deletionEvent, payload: {}, text: "", attachments: [],
        mutation: { type: "message-delete" as const, targetMessageId, deletedAt: 5_000 } }])),
      acknowledgeDeliveries: vi.fn(async () => undefined),
      sendText: vi.fn(async () => ({ event_id: "$text1234:example.com" as const, seq: 4 })),
      sendAttachments: vi.fn(async () => ({ event_id: "$media123:example.com" as const, seq: 4, attachments: [] })),
      deleteMessage,
      editMessage: vi.fn(async () => ({ event_id: "$edit1234:example.com" as const, seq: 4 })),
      setMessageReaction: vi.fn(async () => ({ event_id: "$react123:example.com" as const, seq: 5 })),
      reactionContext: vi.fn(() => ({ available: [], reactions: [], maxSelected: 1 as const })),
      downloadAttachment: vi.fn(async () => new ArrayBuffer(0)),
    };
    const platform = new EdgeChatCrossgramPlatform(client);
    const incoming = await platform.pollOnce();
    expect(incoming).toEqual([expect.objectContaining({ type: "message-delete", eventId: deletionEvent.event_id,
      messageIds: [targetMessageId], timestamp: 5 })]);

    await expect(platform.deleteMessages({}, { id: room.room_id }, [targetMessageId], { forEveryone: false }))
      .rejects.toThrow("for every participant");
    await platform.deleteMessages({}, { id: room.room_id }, [targetMessageId, targetMessageId], { forEveryone: true });
    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith(room.room_id, targetMessageId);
    platform.close();
  });

  it("projects incoming text edits while preserving known attachment parts", async () => {
    const targetMessageId = "$target123:example.com" as const;
    const originalEvent = { event_id: targetMessageId, room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 1, type: "message.file", created_at: 2_000, ciphertext: "ciphertext", metadata: { mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    const editEvent = { event_id: "$edit1234:example.com", room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 2, type: "message.edit", created_at: 5_000, ciphertext: "ciphertext", metadata: { target_event_id: targetMessageId, mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    const attachment = { id: "A".repeat(32), name: "photo.jpg", type: "image/jpeg", size: 10, key: "K".repeat(43), nonce: "N".repeat(16) };
    let pulled = false;
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]),
      pull: vi.fn(async () => pulled ? [] : (pulled = true, [
        { event: originalEvent, payload: {}, text: "before", attachments: [attachment] },
        { event: editEvent, payload: {}, text: "", attachments: [], mutation: {
          type: "message-edit" as const, targetMessageId, text: "after", editedAt: 5_000,
        } },
      ])),
      acknowledgeDeliveries: vi.fn(async () => undefined),
      sendText: vi.fn(async () => ({ event_id: "$text1234:example.com" as const, seq: 3 })),
      sendAttachments: vi.fn(async () => ({ event_id: "$media123:example.com" as const, seq: 3, attachments: [] })),
      deleteMessage: vi.fn(async () => ({ event_id: "$delete12:example.com" as const, seq: 3 })),
      editMessage: vi.fn(async () => ({ event_id: "$edit3456:example.com" as const, seq: 3 })),
      setMessageReaction: vi.fn(async () => ({ event_id: "$react123:example.com" as const, seq: 3 })),
      reactionContext: vi.fn(() => ({ available: [], reactions: [], maxSelected: 1 as const })),
      downloadAttachment: vi.fn(async () => new ArrayBuffer(0)),
    };
    const platform = new EdgeChatCrossgramPlatform(client);
    const events = await platform.pollOnce();
    expect(events[1]).toMatchObject({ type: "message-edit", eventId: editEvent.event_id, message: {
      id: targetMessageId, content: { parts: [{ type: "text", text: "after" }, { type: "media", media: { id: attachment.id } }] },
    } });
    platform.close();
  });

  it("maps final-state reactions in both directions", async () => {
    const targetMessageId = "$target123:example.com" as const;
    const reactionEvent = { event_id: "$react123:example.com", room_id: room.room_id, sender: "@bob:example.com", device_id: "bob-phone",
      seq: 2, type: "message.reaction", created_at: 6_000, ciphertext: "ciphertext", metadata: { target_event_id: targetMessageId, mls_epoch: 1 }, signature: "signature" } as RoomEvent;
    const context = { available: [{ key: "👍", title: "👍", presentation: { type: "emoji" as const, emoticon: "👍" } }],
      reactions: [{ key: "👍", count: 2 }], maxSelected: 1 as const };
    const setMessageReaction = vi.fn(async () => ({ event_id: "$react456:example.com" as const, seq: 3 }));
    let pulled = false;
    const client: EdgeChatGatewayClient = {
      userId: "@alice:example.com",
      rooms: vi.fn(async () => [room]),
      pull: vi.fn(async () => pulled ? [] : (pulled = true, [{ event: reactionEvent, payload: {}, text: "", attachments: [],
        mutation: { type: "message-reaction" as const, targetMessageId, reaction: "👍", actorUserId: "@bob:example.com" as const, updatedAt: 6_000 } }])),
      acknowledgeDeliveries: vi.fn(async () => undefined),
      sendText: vi.fn(async () => ({ event_id: "$text1234:example.com" as const, seq: 3 })),
      sendAttachments: vi.fn(async () => ({ event_id: "$media123:example.com" as const, seq: 3, attachments: [] })),
      deleteMessage: vi.fn(async () => ({ event_id: "$delete12:example.com" as const, seq: 3 })),
      editMessage: vi.fn(async () => ({ event_id: "$edit1234:example.com" as const, seq: 3 })),
      setMessageReaction,
      reactionContext: vi.fn(() => context),
      downloadAttachment: vi.fn(async () => new ArrayBuffer(0)),
    };
    const platform = new EdgeChatCrossgramPlatform(client);
    const incoming = await platform.pollOnce();
    expect(incoming[0]).toMatchObject({ type: "message-reactions", eventId: reactionEvent.event_id,
      target: { conversationId: room.room_id, messageId: targetMessageId }, context });

    const updated = await platform.setMessageReactions({}, {
      conversationId: room.room_id, messageId: targetMessageId, targetId: targetMessageId,
    }, ["👍"]);
    expect(setMessageReaction).toHaveBeenCalledWith(room.room_id, targetMessageId, "👍");
    expect(updated).toEqual(context);
    platform.close();
  });
});
