import { describe, expect, it } from "vitest";
import { assertCompatibleServerProtocol, canonicalAcceptanceReceiptBytes, canonicalSignedEventBytes, currentServerProtocol, isDeliveryReceiptPayload, isMessageDeletePayload, isMessageEditPayload, isMessageExpiryPolicyPayload, isMessageReactionPayload, isNamespacedMessageId, isNamespacedRoomId, isNamespacedUserId, isReadReceiptPayload, LocalFederationTransport, normalizeServerProtocol, serverSupports } from "./index";
import type { ClientEvent } from "./index";

describe("federation-ready identifiers", () => {
  it("requires a domain", () => {
    expect(isNamespacedUserId("@alice:example.com")).toBe(true);
    expect(isNamespacedUserId("alice")).toBe(false);
    expect(isNamespacedRoomId("!0123456789abcdef:example.com")).toBe(true);
    expect(isNamespacedMessageId("$01234567:example.com")).toBe(true);
    expect(isNamespacedMessageId("01234567")).toBe(false);
  });
  it("rejects remote traffic in phase one", async () => {
    const transport = new LocalFederationTransport("example.com");
    await expect(transport.resolveRemoteUser("@bob:remote.test")).rejects.toThrow("disabled");
  });
  it("validates encrypted message tombstones with stable references", () => {
    expect(isMessageDeletePayload({ version: 1, kind: "message.delete", target: { kind: "message", message_id: "$abcdefghi:example.com", room_id: "!0123456789abcdef:example.com" }, deleted_at: 1 })).toBe(true);
    expect(isMessageDeletePayload({ version: 1, kind: "message.delete", target: { kind: "message", message_id: "local-id", room_id: "!0123456789abcdef:example.com" }, deleted_at: 1 })).toBe(false);
  });
  it("validates bounded edit and reaction relations", () => {
    const target = { kind: "message", message_id: "$abcdefghi:example.com", room_id: "!0123456789abcdef:example.com" };
    expect(isMessageEditPayload({ version: 1, kind: "message.edit", target, text: "updated", edited_at: 2 })).toBe(true);
    expect(isMessageEditPayload({ version: 1, kind: "message.edit", target, text: "x".repeat(16_001), edited_at: 2 })).toBe(false);
    expect(isMessageReactionPayload({ version: 1, kind: "message.reaction", target, reaction: "❤️", updated_at: 3 })).toBe(true);
    expect(isMessageReactionPayload({ version: 1, kind: "message.reaction", target, reaction: null, updated_at: 4 })).toBe(true);
  });
  it("validates monotonic read receipt payloads", () => {
    expect(isReadReceiptPayload({ version: 1, kind: "receipt.read", room_id: "!0123456789abcdef:example.com", up_to_seq: 42, read_at: 3 })).toBe(true);
    expect(isReadReceiptPayload({ version: 1, kind: "receipt.read", room_id: "!0123456789abcdef:example.com", up_to_seq: 0, read_at: 3 })).toBe(false);
  });

  it("validates monotonic delivery receipt payloads", () => {
    expect(isDeliveryReceiptPayload({ version: 1, kind: "receipt.delivered", room_id: "!0123456789abcdef:example.com", up_to_seq: 42, delivered_at: 3 })).toBe(true);
    expect(isDeliveryReceiptPayload({ version: 1, kind: "receipt.delivered", room_id: "!0123456789abcdef:example.com", up_to_seq: 0, delivered_at: 3 })).toBe(false);
  });

  it("treats a server without capability metadata as legacy single-attachment v1", () => {
    const legacy = assertCompatibleServerProtocol(undefined);
    expect(legacy).toMatchObject({ version: 1, minimum_client_version: 1, features: [], limits: { max_attachments_per_message: 1 } });
    expect(serverSupports(legacy, "attachments.multi.v1")).toBe(false);
    expect(serverSupports(currentServerProtocol, "attachments.multi.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "history.repair.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "attachments.repair.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "archive.repair.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "messages.contact.v1")).toBe(true);
  });

  it("rejects malformed or incompatible server capability envelopes", () => {
    expect(() => normalizeServerProtocol({ ...currentServerProtocol, limits: { ...currentServerProtocol.limits, max_attachments_per_message: 1000 } })).toThrow("Invalid server protocol");
    expect(() => assertCompatibleServerProtocol({ ...currentServerProtocol, version: 2, minimum_client_version: 2 })).toThrow("更新版本");
    expect(() => normalizeServerProtocol({ ...currentServerProtocol, features: ["attachments.multi.v1", "attachments.multi.v1"] })).toThrow("Invalid server protocol");
  });

  it("canonically binds acceptance receipts to signed envelopes and assigned sequences", () => {
    const event: ClientEvent = { event_id: "event", room_id: "!0123456789abcdef:example.com", sender: "@alice:example.com", device_id: "phone", type: "message.text", created_at: 1, ciphertext: "cipher", metadata: { mls_epoch: 1 }, signature: "signature" };
    expect(new TextDecoder().decode(canonicalSignedEventBytes(event))).toContain('\"signature\":\"signature\"');
    const receipt = { version: 1 as const, key_id: "v1", room_id: event.room_id, seq: 7, event_id: event.event_id, event_hash: "hash", retention_generation: 2, accepted_at: 3 };
    expect(JSON.parse(new TextDecoder().decode(canonicalAcceptanceReceiptBytes(receipt)))).toEqual(receipt);
  });
});

it("validates the bounded encrypted message-expiry policy", () => {
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: 3_600, updated_at: 10 })).toBe(true);
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: null, updated_at: 11 })).toBe(true);
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: 60, updated_at: 12 })).toBe(false);
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: 3_600, updated_at: -1 })).toBe(false);
  expect(serverSupports(currentServerProtocol, "messages.expiry.v1")).toBe(true);
});
