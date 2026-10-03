import { describe, expect, it } from "vitest";
import { canonicalEventBytes, type ClientEvent, type RoomId, type UserId } from "@edgechat/protocol";
import { encodeBase64Url } from "@edgechat/messaging-core";
import { verifyRoomEventSignature } from "./event-authentication";

async function fixture(): Promise<{ event: ClientEvent; publicKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const unsigned: Omit<ClientEvent, "signature"> = {
    event_id: "$event-00000001:example.com", room_id: "!room-000000000001:example.com" as RoomId,
    sender: "@alice:example.com" as UserId, device_id: "alice-phone", type: "message.text",
    created_at: 1, ciphertext: "opaque", metadata: { mls_epoch: 1 },
  };
  const signature = encodeBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, canonicalEventBytes(unsigned)));
  return { event: { ...unsigned, signature }, publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

describe("room event device authentication", () => {
  it("accepts the exact signed envelope and rejects server-side field substitution", async () => {
    const { event, publicKey } = await fixture();
    await expect(verifyRoomEventSignature(event, publicKey)).resolves.toBeUndefined();
    await expect(verifyRoomEventSignature({ ...event, sender: "@mallory:example.com" as UserId }, publicKey)).rejects.toThrow("signature is invalid");
    await expect(verifyRoomEventSignature({ ...event, type: "message.file" }, publicKey)).rejects.toThrow("signature is invalid");
  });

  it("rejects malformed signatures and non-P-256 signing keys", async () => {
    const { event, publicKey } = await fixture();
    await expect(verifyRoomEventSignature({ ...event, signature: "short" }, publicKey)).rejects.toThrow("malformed");
    await expect(verifyRoomEventSignature(event, { ...publicKey, crv: "P-384" })).rejects.toThrow("signing key is invalid");
  });
});
