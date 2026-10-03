import { describe, expect, it, vi } from "vitest";
import { assertMessageAttachmentReferences, assertMessageEnvelope, attachmentEventType, attachmentEventTypeForFiles, attachmentPresentation, createContactMessagePayload, createForwardPayload, createMessagePayload, embeddedImagePreviewByteLength, isAudioAttachment, isPreviewableImage, MAX_EMBEDDED_IMAGE_PREVIEW_BYTES, MAX_INLINE_IMAGE_BYTES, MAX_QUOTE_TEXT_LENGTH, messageAttachments, messageContacts, messageQuote, messageSavedFrom, messageText, normalizeMessagePayload, prepareImageMetadata, quoteTextForMessage, quoteTextSnapshot } from "./media";

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
    expect(() => normalizeMessagePayload(malformed, "$bad-contact:example.com")).toThrow("CONTACT_CARD_INVALID");
    expect(() => createContactMessagePayload("$bad12345:example.com", { user_id: "alice" as never, display_name: "Alice" })).toThrow("CONTACT_CARD_INVALID");
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
      expect(() => normalizeMessagePayload({ version: 2, message_id: "$bad12345:example.com", parts: [{ part_id: "part", kind: "attachment", attachment }] } as never, "$bad12345:example.com")).toThrow("ATTACHMENT_METADATA_INVALID");
    }
  });

  it("keeps small image previews inside the E2EE payload and rejects preview amplification", () => {
    const preview = { type: "image/webp" as const, data: "AAAA", width: 64, height: 48 };
    const payload = createMessagePayload("$preview12:example.com", "", { id: "image", name: "photo.jpg", type: "image/jpeg", size: 42, key: "key", nonce: "nonce", preview });
    expect(messageAttachments(payload)[0]?.attachment.preview).toEqual(preview);
    expect(embeddedImagePreviewByteLength(preview)).toBe(3);

    const oversized = "AAAA".repeat(Math.ceil((MAX_EMBEDDED_IMAGE_PREVIEW_BYTES + 1) / 3));
    expect(() => createMessagePayload("$previewbig:example.com", "", { id: "image", name: "photo.jpg", type: "image/jpeg", size: 42, key: "key", nonce: "nonce", preview: { ...preview, data: oversized } })).toThrow("ATTACHMENT_METADATA_INVALID");
    expect(() => createMessagePayload("$previewfile:example.com", "", { id: "file", name: "notes.txt", type: "text/plain", size: 42, key: "key", nonce: "nonce", preview })).toThrow("ATTACHMENT_METADATA_INVALID");

    const maximum = "AAAA".repeat(Math.floor(MAX_EMBEDDED_IMAGE_PREVIEW_BYTES / 3));
    const attachments = Array.from({ length: 6 }, (_, index) => ({ id: `image-${index}`, name: `${index}.jpg`, type: "image/jpeg", size: 42, key: "key", nonce: "nonce", preview: { ...preview, data: maximum } }));
    expect(() => createMessagePayload("$previewsum:example.com", "", attachments)).toThrow("MESSAGE_PREVIEW_LIMIT_EXCEEDED");
  });

  it("generates a bounded thumbnail on the sending device and closes decoded image memory", async () => {
    const close = vi.fn(); const drawImage = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 800, height: 600, close })));
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName !== "canvas") return originalCreateElement(tagName);
      return {
        width: 0, height: 0,
        getContext: () => ({ drawImage }),
        toBlob: (callback: BlobCallback, type?: string) => callback(new Blob([new Uint8Array(100)], { type })),
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
    try {
      const prepared = await prepareImageMetadata(new File([new Uint8Array(1_024)], "photo.jpg", { type: "image/jpeg" }));
      expect(prepared.dimensions).toEqual({ width: 800, height: 600 });
      expect(prepared.preview).toMatchObject({ type: "image/webp", width: 256, height: 192 });
      expect(embeddedImagePreviewByteLength(prepared.preview!)).toBe(100);
      expect(drawImage).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      createElement.mockRestore(); vi.unstubAllGlobals();
    }
  });

  it("rejects duplicate part IDs and attachment amplification", () => {
    const attachment = (index: number) => ({ id: `attachment_${index}`, name: `${index}.bin`, type: "application/octet-stream", size: 1, key: "key", nonce: "nonce" });
    expect(() => normalizeMessagePayload({ version: 2, message_id: "$duplicate:example.com", parts: [
      { part_id: "same", kind: "text", text: "one" }, { part_id: "same", kind: "text", text: "two" },
    ] }, "$duplicate:example.com")).toThrow("MESSAGE_PAYLOAD_INVALID");
    expect(() => normalizeMessagePayload({ version: 2, message_id: "$many12345:example.com", parts: Array.from({ length: 11 }, (_, index) => ({ part_id: `part-${index}`, kind: "attachment", attachment: attachment(index) })) } as never, "$many12345:example.com")).toThrow("MESSAGE_ATTACHMENT_LIMIT_EXCEEDED");
    expect(() => normalizeMessagePayload({ version: 2, message_id: "$duplicateattachment:example.com", parts: [
      { part_id: "first", kind: "attachment", attachment: attachment(1) }, { part_id: "second", kind: "attachment", attachment: attachment(1) },
    ] } as never, "$duplicateattachment:example.com")).toThrow("ATTACHMENT_REFERENCE_DUPLICATE");
  });

  it("binds decrypted attachment IDs and order to the server-authorized references", () => {
    const payload = createMessagePayload("$binding123:example.com", "", [
      { id: "attachment_one", name: "one.bin", type: "application/octet-stream", size: 1, key: "key", nonce: "nonce" },
      { id: "attachment_two", name: "two.bin", type: "application/octet-stream", size: 1, key: "key", nonce: "nonce" },
    ]);
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_ids: ["attachment_one", "attachment_two"] })).not.toThrow();
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_ids: ["attachment_two", "attachment_one"] })).toThrow("ATTACHMENT_REFERENCE_ENVELOPE_MISMATCH");
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_ids: ["attachment_one", "attachment_one"] })).toThrow("ATTACHMENT_REFERENCES_INVALID");
    expect(() => assertMessageAttachmentReferences(payload, "message.file", { attachment_id: "attachment_one", attachment_ids: ["attachment_one", "attachment_two"] })).toThrow("ATTACHMENT_REFERENCE_FORMAT_CONFLICT");
    expect(() => assertMessageAttachmentReferences(payload, "message.text", { attachment_ids: ["attachment_one", "attachment_two"] })).toThrow("ATTACHMENT_REFERENCE_ENVELOPE_MISMATCH");
  });

  it("binds the logical message ID, relation room, and visible event shape", () => {
    const room = "!0123456789abcdef:example.com";
    const eventId = "$event1234:example.com";
    const text = createMessagePayload(eventId, "hello");
    expect(() => assertMessageEnvelope(text, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).not.toThrow();
    expect(() => normalizeMessagePayload({ ...text, message_id: "$forged123:example.com" }, eventId)).toThrow("MESSAGE_ID_EVENT_MISMATCH");
    expect(() => assertMessageEnvelope({ ...text, relation: { type: "reply", target: { kind: "message", message_id: "$target123:example.com", room_id: "!fedcba9876543210:example.com" } } }, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).toThrow("MESSAGE_RELATION_ROOM_MISMATCH");
    const contact = createContactMessagePayload(eventId, { user_id: "@alice:example.com", display_name: "Alice" });
    expect(() => assertMessageEnvelope(contact, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).toThrow("TEXT_MESSAGE_PARTS_INVALID");
    expect(() => assertMessageEnvelope(contact, { event_id: eventId, room_id: room, type: "message.contact", metadata: {} })).not.toThrow();
  });

  it("accepts only capability-bound Bot provenance", () => {
    const eventId = "$botmsg123:example.com"; const room = "!0123456789abcdef:example.com";
    const botId = "bot_0123456789abcdef";
    const payload = normalizeMessagePayload({ version: 2, message_id: eventId, origin: { kind: "bot", bot_id: botId, display_name: " Alerts " }, parts: [{ part_id: "text", kind: "text", text: "build done" }] }, eventId);
    expect(payload.origin?.display_name).toBe("Alerts");
    expect(() => assertMessageEnvelope(payload, { event_id: eventId, room_id: room, type: "message.text", metadata: { sender_kind: "bot", bot_id: botId } })).not.toThrow();
    expect(() => assertMessageEnvelope(payload, { event_id: eventId, room_id: room, type: "message.text", metadata: {} })).toThrow("BOT_ORIGIN_AUTHORIZATION_MISMATCH");
    expect(() => assertMessageEnvelope(createMessagePayload(eventId, "human"), { event_id: eventId, room_id: room, type: "message.text", metadata: { sender_kind: "bot", bot_id: botId } })).toThrow("BOT_ORIGIN_UNAUTHENTICATED");
    expect(() => normalizeMessagePayload({ ...payload, origin: { ...payload.origin!, display_name: "bad\u202ename" } }, eventId)).toThrow("MESSAGE_ORIGIN_INVALID");
  });
});
