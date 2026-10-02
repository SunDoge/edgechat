import { describe, expect, it } from "vitest";
import { attachmentEventType, attachmentEventTypeForFiles, createContactMessagePayload, createForwardPayload, createMessagePayload, isPreviewableImage, isVoiceAttachment, MAX_QUOTE_TEXT_LENGTH, messageAttachments, messageContacts, messageQuote, messageSavedFrom, messageText, normalizeMessagePayload, quoteTextForMessage, quoteTextSnapshot } from "./media";

describe("image message classification", () => {
  it("uses image events only for safely previewable raster formats", () => {
    expect(attachmentEventType({ type: "image/jpeg" })).toBe("message.image");
    expect(attachmentEventType({ type: "image/webp" })).toBe("message.image");
    expect(attachmentEventType({ type: "image/svg+xml" })).toBe("message.file");
    expect(attachmentEventType({ type: "text/html" })).toBe("message.file");
    expect(attachmentEventTypeForFiles([{ type: "image/jpeg" }, { type: "image/png" }])).toBe("message.image");
    expect(attachmentEventTypeForFiles([{ type: "image/jpeg" }, { type: "application/pdf" }])).toBe("message.file");
    expect(attachmentEventTypeForFiles([])).toBe("message.text");
  });

  it("normalizes MIME casing", () => {
    expect(isPreviewableImage("IMAGE/PNG")).toBe(true);
  });

  it("gives every logical message and content part a stable ID", () => {
    const payload = createMessagePayload("$message:example.com", "hello", { id: "attachment", name: "photo.png", type: "image/png", size: 4, key: "key", nonce: "nonce" }, { type: "reply", target: { kind: "message", message_id: "$target123:example.com", room_id: "!0123456789abcdef:example.com" } });
    expect(payload.message_id).toBe("$message:example.com");
    expect(new Set(payload.parts.map((part) => part.part_id)).size).toBe(2);
    expect(messageText(payload)).toBe("hello");
    expect(messageAttachments(payload)[0].kind).toBe("image");
    expect(payload.relation?.target.message_id).toBe("$target123:example.com");
  });

  it("keeps legacy payloads readable", () => {
    const payload = normalizeMessagePayload({ text: "old message" }, "$legacy:example.com");
    expect(payload.message_id).toBe("$legacy:example.com");
    expect(messageText(payload)).toBe("old message");
  });

  it("keeps a bounded quote snapshot inside the encrypted payload", () => {
    const payload = createMessagePayload("$quote:example.com", "my response", undefined, {
      type: "quote",
      target: { kind: "message", message_id: "$target:example.com", room_id: "!0123456789abcdef:example.com" },
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

  it("drops malformed contact cards at the rendering boundary", () => {
    const malformed = { version: 2, message_id: "$bad-contact:example.com", parts: [
      { part_id: "one", kind: "contact", contact: { user_id: "alice", display_name: "Alice" } },
      { part_id: "two", kind: "contact", contact: { user_id: "@alice:example.com", display_name: "x".repeat(129) } },
    ] } as never;
    expect(messageContacts(normalizeMessagePayload(malformed, "$fallback:example.com"))).toEqual([]);
    expect(() => createContactMessagePayload("$bad:example.com", { user_id: "alice" as never, display_name: "Alice" })).toThrow("联系人名片无效");
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

  it("classifies bounded audio recordings as voice parts", () => {
    expect(isVoiceAttachment({ type: "audio/webm;codecs=opus", duration_ms: 12_500 })).toBe(true);
    expect(isVoiceAttachment({ type: "audio/webm", duration_ms: Number.NaN })).toBe(false);
    expect(isVoiceAttachment({ type: "audio/webm", duration_ms: 600_001 })).toBe(false);
    expect(isVoiceAttachment({ type: "application/octet-stream", duration_ms: 12_500 })).toBe(false);

    const payload = createMessagePayload("$voice:example.com", "", { id: "audio", name: "voice.webm", type: "audio/webm;codecs=opus", size: 42, key: "key", nonce: "nonce", duration_ms: 12_500 });
    expect(messageAttachments(payload)[0]).toMatchObject({ kind: "voice", attachment: { duration_ms: 12_500 } });
  });

  it("preserves voice semantics while forwarding through a zero-copy alias", () => {
    const source = createMessagePayload("$voice-source:example.com", "", { id: "source-audio", name: "voice.ogg", type: "audio/ogg;codecs=opus", size: 42, key: "key", nonce: "nonce", duration_ms: 4_000 });
    const forwarded = createForwardPayload("$voice-forward:example.com", source, ["voice-alias"]);
    expect(messageAttachments(forwarded)[0]).toMatchObject({ kind: "voice", attachment: { id: "voice-alias", duration_ms: 4_000 } });
  });
});
