import { describe, expect, it } from "vitest";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import { operationErrorMessage } from "./operation-errors";
import { openRoomPeerRecovery, RoomPeerRecoveryError, sealRoomPeerRecovery, type RoomPeerRecoveryContext } from "./room-peer-recovery";

const roomId = "!peer-recovery:example.com" as RoomId;
function event(seq: number): RoomEvent {
  return { event_id: `$test-event-${seq}:example.com`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "sender-device",
    type: "message.text", created_at: seq, ciphertext: `ciphertext-${seq}`, metadata: { mls_epoch: 1 }, signature: `signature-${seq}` };
}

describe("room peer recovery bundles", () => {
  it("compresses and authenticates one exact contiguous event range for its target device", async () => {
    const core = new WebCryptoMessagingCore(); const source = await core.createIdentity(); const target = await core.createIdentity();
    const context: RoomPeerRecoveryContext = { recoveryId: "recovery-0123456789", roomId, sourceDeviceId: source.deviceId,
      targetDeviceId: target.deviceId, afterSeq: 10, throughSeq: 12 };
    const events = [event(11), event(12)];
    const targetKey = await crypto.subtle.exportKey("jwk", target.encryptionPublicKey);
    const sourceKey = await crypto.subtle.exportKey("jwk", source.encryptionPublicKey);
    const bundle = await sealRoomPeerRecovery(events, context, source, targetKey);
    expect(bundle.type).toBe("application/vnd.edgechat.room-recovery");
    await expect(openRoomPeerRecovery(bundle, context, target, sourceKey)).resolves.toEqual(events);
  });

  it("rejects tampering, a different target, and non-contiguous source records", async () => {
    const core = new WebCryptoMessagingCore(); const source = await core.createIdentity(); const target = await core.createIdentity(); const wrong = await core.createIdentity();
    const context: RoomPeerRecoveryContext = { recoveryId: "recovery-abcdefghij", roomId, sourceDeviceId: source.deviceId,
      targetDeviceId: target.deviceId, afterSeq: 0, throughSeq: 2 };
    const targetKey = await crypto.subtle.exportKey("jwk", target.encryptionPublicKey);
    const sourceKey = await crypto.subtle.exportKey("jwk", source.encryptionPublicKey);
    await expect(sealRoomPeerRecovery([event(1), event(3)], context, source, targetKey)).rejects.toMatchObject({
      code: "invalid_source_range",
      messageKey: "workspace.historyRecovery.error.sourceRange",
    });
    const bundle = await sealRoomPeerRecovery([event(1), event(2)], context, source, targetKey);
    const bytes = new Uint8Array(await bundle.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
    await expect(openRoomPeerRecovery(new Blob([bytes]), context, target, sourceKey)).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(openRoomPeerRecovery(bundle, { ...context, targetDeviceId: wrong.deviceId }, wrong, sourceKey)).rejects.toMatchObject({ code: "wrong_request" });
    await expect(openRoomPeerRecovery(bundle, context, target, await crypto.subtle.exportKey("jwk", wrong.encryptionPublicKey))).rejects.toMatchObject({
      code: "source_identity_mismatch",
    });
  });

  it("rejects malformed packages with a stable, localized error", async () => {
    const core = new WebCryptoMessagingCore(); const target = await core.createIdentity(); const source = await core.createIdentity();
    const context: RoomPeerRecoveryContext = { recoveryId: "recovery-malformed", roomId, sourceDeviceId: source.deviceId,
      targetDeviceId: target.deviceId, afterSeq: 0, throughSeq: 1 };
    const sourceKey = await crypto.subtle.exportKey("jwk", source.encryptionPublicKey);

    let error: unknown;
    try { await openRoomPeerRecovery(new Blob([new Uint8Array(32)]), context, target, sourceKey); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(RoomPeerRecoveryError);
    expect(error).toMatchObject({ code: "invalid_package", messageKey: "workspace.historyRecovery.error.invalidPackage" });
    expect(operationErrorMessage(error, "fallback")).toContain("恢复数据格式无效");
  });
});
