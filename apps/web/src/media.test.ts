import { describe, expect, it } from "vitest";
import { assertMessageAttachmentReferences, assertMessageEnvelope, attachmentEventType, attachmentEventTypeForFiles, attachmentPresentation, createContactMessagePayload, createForwardPayload, createMessagePayload, isAudioAttachment, isPreviewableImage, MAX_INLINE_IMAGE_BYTES, MAX_QUOTE_TEXT_LENGTH, messageAttachments, messageContacts, messageQuote, messageSavedFrom, messageText, normalizeMessagePayload, quoteTextForMessage, quoteTextSnapshot } from "./media";

describe("unified attachment presentation", () => {
  it("uses one attachment event and derives bounded previews locally", () => {
    expect(attachmentEventType({ type: "image/jpeg" })).toBe("message.file");
    expect(attachmentEventType({ type: "image/webp" })).toBe("message.file");
    expect(attachmentEventType({ type: "image/svg+xml" })).toBe("message.file");
    expect(attachmentEventType({ type: "text/html" })).toBe("message.file");
    expect(attachmentEventTypeForFiles([{ type: "image/jpeg" }, { type: "image/png" }])).toBe("message.file");
    expect(attachmentEventTypeForFiles([{ type: "image/jpeg" }, { type: "application/pdf" }])).toBe("message.file");
    expect(attachmentEventTypeForFiles([])).toBe("message.text");
    expect(attachmentPresentation({ type: "image/jpeg", size: 1024, width: 800, height: 600 })).toBe("image");
    expect(attachmentPresentation({ type: "image/jpeg", size: MAX_INLINE_IMAGE_BYTES + 1 })).toBe("file");
    expect(attachmentPresentation({ type: "image/jpeg", size: 1024, width: 20_000, height: 100 })).toBe("file");
    expect(attachmentPresentation({ type: "audio/mpeg", size: 1024 })).toBe("audio");
  });

  it("normalizes MIME casing", () => {
    expect(isPreviewableImage("IMAGE/PNG")).toBe(true);
  });

  it("gives every logical message and content part a stable ID", () => {
    const payload = createMessagePayload("$message123:example.com", "hello", { id: "attachment", name: "photo.png", type: "image/png", size: 4, key: "key", nonce: "nonce" }, { type: "reply", target: { kind: "message", message_id: "$target123:example.com", room_id: "!0123456789abcdef:example.com" } });
    expect(payload.message_id).toBe("$message123:example.com");
    expect(new Set(payload.parts.map((part) => part.part_id)).size).toBe(2);
    expect(messageText(payload)).toBe("hello");
    expect(messageAttachments(payload)[0].kind).toBe("attachment");
    expect(payload.relation?.target.message_id).toBe("$target123:example.com");
  });

  it("keeps legacy payloads readable", () => {
    const payload = normalizeMessagePayload({ text: "old message" }, "$legacy123:example.com");
    expect(payload.message_id).toBe("$legacy123:example.com");
    expect(messageText(payload)).toBe("old message");
  });

  it("keeps a bounded quote snapshot inside the encrypted payload", () => {
    const payload = createMessagePayload("$quote1234:example.com", "my response", undefined, {
      type: "quote",
      target: { kind: "message", message_id: "$target123:example.com", room_id: "!0123456789abcdef:example.com" },
      snapshot: { text: "quoted text", sender: "@alice:example.com", display_name: "Alice" },
    });
    expect(messageQuote(payload)).toEqual({ text: "quoted text", sender: "@alice:example.com", display_name: "Alice" });
    expect(quoteTextSnapshot(`  ${"x".repeat(MAX_QUOTE_TEXT_LENGTH + 20)}  `)).toHaveLength(MAX_QUOTE_TEXT_LENGTH);
    expect(messageText(payload)).toBe("my response");
    expect(quoteTextForMessage("first line\nsecond line", "second line")).toBe("second line");
    expect(quoteTextForMessage("first line", "forged text")).toBe("first line");
  });

  it("creates a new logical message and attachment alias when forwarding", () => {
    const source = createMessagePayload("$source123:example.com", "caption", { id: "source-attachment", name: "photo.png", type: "image/png", size: 4, key: "key", nonce: "nonce" });
    const forwarded = createForwardPayload("$forward123:example.com", source, ["forward-alias"]);
    expect(forwarded).toMatchObject({ message_id: "$forward123:example.com", forwarded: true });
    expect(messageText(forwarded)).toBe("caption");
    expect(messageAttachments(forwarded)[0].attachment).toMatchObject({ id: "forward-alias", key: "key", nonce: "nonce" });
    expect(forwarded.parts.map((part) => part.part_id)).not.toEqual(source.parts.map((part) => part.part_id));
  });

  it("keeps a validated encrypted backlink only for saved-message copies", () => {
    const source = createMessagePayload("$source123:example.com", "remember me");
    const reference = { kind: "message" as const, message_id: source.message_id, room_id: "!0123456789abcdef:example.com" as const };
    const saved = createForwardPayload("$saved123:example.com", source, [], reference);
    expect(messageSavedFrom(saved)).toEqual(reference);
    expect(messageSavedFrom(createForwardPayload("$forward123:example.com", source))).toBeNull();
    expect(messageSavedFrom({ ...saved, saved_from: { ...reference, room_id: "local-room" as never } })).toBeNull();
  });

  it("keeps contact cards inside the encrypted message payload and forwards them without an object alias", () => {
    const source = createContactMessagePayload("$contact-source:example.com", { user_id: "@alice:example.com", display_name: " Alice " });
    expect(messageContacts(source)).toEqual([{ part_id: expect.any(String), kind: "contact", contact: { user_id: "@alice:example.com", display_name: "Alice" } }]);
    expect(messageText(source)).toBe("");
    expect(messageAttachments(source)).toEqual([]);
    const forwarded = createForwardPayload("$contact-forward:example.com", source);
    expect(messageContacts(forwarded)[0]?.contact).toEqual({ user_id: "@alice:example.com", display_name: "Alice" });
    expect(forwarded.parts[0]?.part_id).not.toBe(source.parts[0]?.part_id);
  });

  it("rejects malformed contact cards at the decrypted payload boundary", () => {
    const malformed = { version: 2, message_id: "$bad-contact:example.com", parts: [
      { part_id: "one", kind: "contact", contact: { user_id: "alice", display_name: "Alice" } },
      { part_id: "two", kind: "contact", contact: { user_id: "@alice:example.com", display_name: "x".repeat(129) } },
    ] } as never;
    expect(() => normalizeMessagePayload(malformed, "$bad-contact:example.com")).toThrow("联系人名片无效");
    expect(() => createContactMessagePayload("$bad12345:example.com", { user_id: "alice" as never, display_name: "Alice" })).toThrow("联系人名片无效");
  });

  it("keeps multiple attachments in one logical message and assigns independent forward aliases", () => {
    const source = createMessagePayload("$multi-source:example.com", "album", [
      { id: "source-a", name: "a.jpg", type: "image/jpeg", size: 4, key: "key-a", nonce: "nonce-a" },
      { id: "source-b", name: "b.pdf", type: "application/pdf", size: 8, key: "key-b", nonce: "nonce-b" },
    ]);
    expect(messageAttachments(source).map((part) => part.attachment.id)).toEqual(["source-a", "source-b"]);
    const forwarded = createForwardPayload("$multi-forward:example.com", source, ["alias-a", "alias-b"]);
    expect(messageAttachments(forwarded).map((part) => part.attachment.id)).toEqual(["alias-a", "alias-b"]);
  });

  it("treats audio as the same attachment type and keeps optional duration metadata", () => {
    expect(isAudioAttachment({ type: "audio/webm;codecs=opus" })).toBe(true);
    expect(isAudioAttachment({ type: "application/octet-stream" })).toBe(false);

    const payload = createMessagePayload("$voice1234:example.com", "", { id: "audio", name: "voice.webm", type: "audio/webm;codecs=opus", size: 42, key: "key", nonce: "nonce", duration_ms: 12_500 });
    expect(messageAttachments(payload)[0]).toMatchObject({ kind: "attachment", attachment: { duration_ms: 12_500 } });
  });

  it("preserves voice semantics while forwarding through a zero-copy alias", () => {
    const source = createMessagePayload("$voice-source:example.com", "", { id: "source-audio", name: "voice.ogg", type: "audio/ogg;codecs=opus", size: 42, key: "key", nonce: "nonce", duration_ms: 4_000 });
    const forwarded = createForwardPayload("$voice-forward:example.com", source, ["voice-alias"]);
    expect(messageAttachments(forwarded)[0]).toMatchObject({ kind: "attachment", attachment: { id: "voice-alias", duration_ms: 4_000 } });
  });

  it("bounds and normalizes untrusted attachment metadata before local projection", () => {
    const valid = { id: "attachment_123", name: " photo.JPG ", type: "IMAGE/JPEG", size: 42, key: "key_123", nonce: "nonce_123", width: 800, height: 600 };
    const payload = normalizeMessagePayload({ version: 2, message_id: "$safe12345:example.com", parts: [{ part_id: "part", kind: "attachment", attachment: valid }] }, "$safe12345:example.com");
    expect(messageAttachments(payload)[0]?.attachment).toMatchObject({ name: "photo.JPG", type: "image/jpeg", width: 800, height: 600 });
    for (const attachment of [
      { ...valid, id: "../escape" },
      { ...valid, name: "folder/photo.jpg" },
      { ...valid, name: "photo\u202egpj" },
      { ...valid, type: "image/png\nX-Test: bad" },
      { ...valid, size: 25 * 1024 * 1024 + 1 },
      { ...valid, height: undefined },
      { ...valid, duration_ms: 600_001 },
      { ...valid, key: "not+base64" },
    ]) {
      expect(() => normalizeMessagePayload({ version: 2, message_id: "$bad12345:example.com", parts: [{ part_id: "part", kind: "attachment", attachment }] } as never, "$bad12345:example.com")).toThrow("附件元数据无效");
    }
  });

  it("rejects duplicate part IDs and attachment amplification", () => {
    const attachment = (index: number) => ({ id: `attachment_${index}`, name: `${index}.bin`, type: "application/octet-stream", size: 1, key: "key", nonce: "nonce" });
    expect(() => normalizeMessagePayload({ version: 2, message_id: "$duplicate:example.com", parts: [
      { part_id: "same", kind: "text", text: "one" }, { part_id: "same", kind: "text", text: "two" },
    ] }, "$duplicate:example.com")).toThrow("消息内容格式无效");
    expect(() => normalizeMessagePayload({ version: 2, message_id: "$many12345:example.com", parts: Array.from({ length: 11 }, (_, index) => ({ part_id: `part-${index}`, kind: "attachment", attachment: attachment(index) })) } as never, "$many12345:example.com")).toThrow("附件数量或总大小无效");
    expect(() => normalizeMessagePayload({ version: 2, message_id: "$duplicateattachment:example.com", parts: [
      { part_id: "first", kind: "attachment", attachment: attachment(1) }, { part_id: "second", kind: "attachment", attachment: attachment(1) },
    ] } as never, "$duplicateattachment:example.com")).toThrow("附件引用重复");
  });

  it("binds decrypted attachment IDs and order to the server-authorized references", () => {
    const payload = createMessagePayload("$binding123:example.com", "", [
      { id: "attachment_one", name: "one.bin", type: "application/octet-stream", size: 1, key: "key", nonce: "nonce" },
      { id: "attachment_two", name: "two.bin", type: "application/octet-stream", size: 1, key: "key", nonce: "nonce" },
    ]);
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_ids: ["attachment_one", "attachment_two"] })).not.toThrow();
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_ids: ["attachment_two", "attachment_one"] })).toThrow("不一致");
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_ids: ["attachment_one", "attachment_one"] })).toThrow("格式无效");
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_id: "attachment_one", attachment_ids: ["attachment_one", "attachment_two"] })).toThrow("格式冲突");
    expect(() => assertMessageAttachmentReferences(payload, "message.text", { attachment_ids: ["attachment_one", "attachment_two"] })).toThrow("不一致");
  });

  it("binds the logical message ID, relation room, and visible event shape", () => {
    const room = "!0123456789abcdef:example.com";
    const eventId = "$event1234:example.com";
    const text = createMessagePayload(eventId, "hello");
    expect(() => assertMessageEnvelope(text, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).not.toThrow();
    expect(() => normalizeMessagePayload({ ...text, message_id: "$forged123:example.com" }, eventId)).toThrow("不一致");
    expect(() => assertMessageEnvelope({ ...text, relation: { type: "reply", target: { kind: "message", message_id: "$target123:example.com", room_id: "!fedcba9876543210:example.com" } } }, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).toThrow("跨越");
    const contact = createContactMessagePayload(eventId, { user_id: "@alice:example.com", display_name: "Alice" });
    expect(() => assertMessageEnvelope(contact, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).toThrow("文字消息");
    expect(() => assertMessageEnvelope(contact, { event_id: eventId, room_id: room, type: "message.contact", metadata: {} })).not.toThrow();
  });

  it("accepts only capability-bound Bot provenance", () => {
    const eventId = "$botmsg123:example.com"; const room = "!0123456789abcdef:example.com";
    const botId = "bot_0123456789abcdef";
    const payload = normalizeMessagePayload({ version: 2, message_id: eventId, origin: { kind: "bot", bot_id: botId, display_name: " Alerts " }, parts: [{ part_id: "text", kind: "text", text: "build done" }] }, eventId);
    expect(payload.origin?.display_name).toBe("Alerts");
    expect(() => assertMessageEnvelope(payload, { event_id: eventId, room_id: room, type: "message.text", metadata: { sender_kind: "bot", bot_id: botId } })).not.toThrow();
    expect(() => assertMessageEnvelope(payload, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).toThrow("Bot 来源");
    expect(() => assertMessageEnvelope(createMessagePayload(eventId, "human"), { event_id: eventId, room_id: room, type: "message.text", metadata: { sender_kind: "bot", bot_id: botId } })).toThrow("未认证");
    expect(() => normalizeMessagePayload({ ...payload, origin: { ...payload.origin!, display_name: "bad\u202ename" } }, eventId)).toThrow("消息来源格式无效");
  });
});
