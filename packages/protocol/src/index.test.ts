import { describe, expect, it } from "vitest";
import { acceptedEventMatchesClientEvent, assertCompatibleServerProtocol, canonicalAcceptanceReceiptBytes, canonicalSignedEventBytes, currentServerProtocol, deviceSessionProofBytes, isClientEventEnvelope, isDeliveryReceiptPayload, isMessageDeletePayload, isMessageEditPayload, isMessageExpiryPolicyPayload, isMessageReactionPayload, isMlsMembershipCommitEventType, isNamespacedEventId, isNamespacedMessageId, isNamespacedRoomId, isNamespacedUserId, isReadReceiptPayload, isRoomEventEnvelope, isRoomOwnerTransferPayload, isRoomProfilePayload, LocalFederationTransport, MAX_EVENT_CIPHERTEXT_LENGTH, normalizeLocalUserId, normalizeServerProtocol, serverSupports } from "./index";
import type { ClientEvent } from "./index";

describe("federation-ready identifiers", () => {
  it("requires a domain", () => {
    expect(isNamespacedUserId("@alice:example.com")).toBe(true);
    expect(isNamespacedUserId("alice")).toBe(false);
    expect(isNamespacedRoomId("!0123456789abcdef:example.com")).toBe(true);
    expect(isNamespacedEventId("$01234567:example.com")).toBe(true);
    expect(isNamespacedEventId("$01234567")).toBe(false);
    expect(isNamespacedMessageId("$01234567:example.com")).toBe(true);
    expect(isNamespacedMessageId("01234567")).toBe(false);
  });
  it("normalizes only complete identifiers from the local server", () => {
    expect(normalizeLocalUserId("  @Alice:Example.COM  ", "example.com")).toBe("@alice:example.com");
    expect(normalizeLocalUserId("alice", "example.com")).toBeNull();
    expect(normalizeLocalUserId("@alice:remote.test", "example.com")).toBeNull();
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
    expect(serverSupports(currentServerProtocol, "attachments.idempotent-upload.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "archive.repair.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "messages.contact.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "rooms.profile.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "rooms.leave.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "rooms.owner-transfer.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "account.password-change.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "device-session.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "passkeys.v1")).toBe(true);
    expect(serverSupports(currentServerProtocol, "accounts.opaque.v1")).toBe(true);
  });

  it("rejects malformed or incompatible server capability envelopes", () => {
    expect(() => normalizeServerProtocol({ ...currentServerProtocol, limits: { ...currentServerProtocol.limits, max_attachments_per_message: 1000 } })).toThrow("Invalid server protocol");
    expect(() => assertCompatibleServerProtocol({ ...currentServerProtocol, version: 2, minimum_client_version: 2 })).toThrow("更新版本");
    expect(() => normalizeServerProtocol({ ...currentServerProtocol, features: ["attachments.multi.v1", "attachments.multi.v1"] })).toThrow("Invalid server protocol");
  });

  it("canonically binds acceptance receipts to signed envelopes and assigned sequences", () => {
    const event: ClientEvent = { event_id: "$01234567:example.com", room_id: "!0123456789abcdef:example.com", sender: "@alice:example.com", device_id: "phone", type: "message.text", created_at: 1, ciphertext: "cipher", metadata: { mls_epoch: 1 }, signature: "signature" };
    expect(new TextDecoder().decode(canonicalSignedEventBytes(event))).toContain('\"signature\":\"signature\"');
    const receipt = { version: 1 as const, key_id: "v1", room_id: event.room_id, seq: 7, event_id: event.event_id, event_hash: "hash", retention_generation: 2, accepted_at: 3 };
    expect(JSON.parse(new TextDecoder().decode(canonicalAcceptanceReceiptBytes(receipt)))).toEqual(receipt);
  });

  it("binds a device-session proof to its server, device, expiry, and challenge", () => {
    const challenge = { version: 1 as const, challenge_id: "challenge", device_id: "device", challenge: "secret", expires_at: 123, server_name: "example.com" };
    expect(JSON.parse(new TextDecoder().decode(deviceSessionProofBytes(challenge)))).toEqual(challenge);
    expect(deviceSessionProofBytes({ ...challenge, server_name: "elsewhere.example" })).not.toEqual(deviceSessionProofBytes(challenge));
  });

  it("only accepts server ordering for the exact submitted signed envelope", () => {
    const submitted: ClientEvent = { event_id: "$01234567:example.com", room_id: "!0123456789abcdef:example.com", sender: "@alice:example.com", device_id: "phone", type: "control.group.commit", created_at: 1, ciphertext: "commit", metadata: { mls_epoch: 2 }, signature: "signature" };
    const accepted = { ...submitted, seq: 7 };
    expect(acceptedEventMatchesClientEvent(accepted, submitted)).toBe(true);
    expect(acceptedEventMatchesClientEvent({ ...accepted, acceptance_receipt: { version: 1, key_id: "v1", room_id: submitted.room_id, seq: 7, event_id: submitted.event_id, event_hash: "hash", retention_generation: 1, accepted_at: 2, mac: "mac" } }, submitted)).toBe(true);
    expect(acceptedEventMatchesClientEvent({ ...accepted, ciphertext: "substituted" }, submitted)).toBe(false);
    expect(acceptedEventMatchesClientEvent({ ...accepted, signature: "substituted" }, submitted)).toBe(false);
    expect(acceptedEventMatchesClientEvent(null, submitted)).toBe(false);
  });

  it("validates an ordered ciphertext envelope and binds its optional acceptance receipt", () => {
    const event = { event_id: "$01234567:example.com", room_id: "!0123456789abcdef:example.com", seq: 7, sender: "@alice:example.com", device_id: "phone", type: "message.text", created_at: 1, ciphertext: "cipher", metadata: { mls_epoch: 1, attachment_ids: ["opaque"] }, signature: "signature" } as const;
    expect(isClientEventEnvelope(event)).toBe(true);
    expect(isRoomEventEnvelope(event)).toBe(true);
    expect(isRoomEventEnvelope({ ...event, event_id: "local-only" })).toBe(false);
    expect(isRoomEventEnvelope({ ...event, room_id: "!short:example.com" })).toBe(false);
    expect(isRoomEventEnvelope({ ...event, metadata: { nested: { plaintext: true } } })).toBe(false);
    expect(isClientEventEnvelope({ ...event, ciphertext: "x".repeat(MAX_EVENT_CIPHERTEXT_LENGTH + 1) })).toBe(false);
    expect(isRoomEventEnvelope({ ...event, acceptance_receipt: { version: 1, key_id: "v1", room_id: event.room_id, seq: 8, event_id: event.event_id, event_hash: "hash", retention_generation: 1, accepted_at: 2, mac: "mac" } })).toBe(false);
    expect(isRoomEventEnvelope({ ...event, acceptance_receipt: { version: 1, key_id: "v1", room_id: event.room_id, seq: event.seq, event_id: event.event_id, event_hash: "hash", retention_generation: 1, accepted_at: 2, mac: "mac" } })).toBe(true);
  });

  it("classifies every epoch-advancing MLS membership event as unskippable", () => {
    expect(isMlsMembershipCommitEventType("control.group.commit")).toBe(true);
    expect(isMlsMembershipCommitEventType("control.device.add")).toBe(true);
    expect(isMlsMembershipCommitEventType("control.device.revoke")).toBe(true);
    expect(isMlsMembershipCommitEventType("control.room.profile")).toBe(false);
    expect(isMlsMembershipCommitEventType("message.text")).toBe(false);
  });
});

it("validates encrypted room ownership transfers", () => {
  expect(isRoomOwnerTransferPayload({ version: 1, kind: "room.owner-transfer", target_user_id: "@bob:example.com", updated_at: 10 })).toBe(true);
  expect(isRoomOwnerTransferPayload({ version: 1, kind: "room.owner-transfer", target_user_id: "bob", updated_at: 10 })).toBe(false);
});

it("validates the bounded encrypted message-expiry policy", () => {
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: 3_600, updated_at: 10 })).toBe(true);
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: null, updated_at: 11 })).toBe(true);
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: 60, updated_at: 12 })).toBe(false);
  expect(isMessageExpiryPolicyPayload({ version: 1, kind: "room.message-expiry", expires_in_seconds: 3_600, updated_at: -1 })).toBe(false);
  expect(serverSupports(currentServerProtocol, "messages.expiry.v1")).toBe(true);
});

it("validates bounded encrypted room profiles", () => {
  const avatar = { attachment_id: "avatar-0123456789", mime_type: "image/webp", plaintext_bytes: 1024,
    key: "A".repeat(43), nonce: "B".repeat(16) };
  const preview = { type: "image/webp", data: "AQID", width: 64, height: 64 };
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "Weekend plans", avatar: null, updated_at: 10 })).toBe(true);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "Weekend plans", avatar, updated_at: 10 })).toBe(true);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "Weekend plans", avatar: { ...avatar, preview }, updated_at: 10 })).toBe(true);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "Weekend plans", avatar: { ...avatar, preview: { ...preview, data: "A".repeat(10_924) } }, updated_at: 10 })).toBe(false);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "Weekend plans", avatar: { ...avatar, preview: { ...preview, width: 257 } }, updated_at: 10 })).toBe(false);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "Weekend plans", avatar: { ...avatar, plaintext_bytes: 128 * 1024 + 1 }, updated_at: 10 })).toBe(false);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: " padded ", avatar: null, updated_at: 10 })).toBe(false);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "x".repeat(101), avatar: null, updated_at: 10 })).toBe(false);
  expect(isRoomProfilePayload({ version: 1, kind: "room.profile", name: "bad\nname", avatar: null, updated_at: 10 })).toBe(false);
});
