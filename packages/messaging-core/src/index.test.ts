import { describe, expect, it } from "vitest";
import { decodeBase64Url, deviceFingerprint, deviceLinkClaimBytes, openAccountCredential, openArchiveSegmentKey, sealAccountCredential, sealArchiveSegmentKey, WebCryptoMessagingCore } from "./index";

describe("device support crypto", () => {
  it("encrypts attachments and rejects a changed authentication tag", async () => {
    const core = new WebCryptoMessagingCore();
    const encrypted = await core.encryptAttachment(new TextEncoder().encode("attachment").buffer);
    expect(new TextDecoder().decode(await core.decryptAttachment(encrypted.ciphertext, encrypted.key, encrypted.nonce))).toBe("attachment");
    const tampered = encrypted.ciphertext.slice(0); new Uint8Array(tampered)[0] ^= 1;
    await expect(core.decryptAttachment(tampered, encrypted.key, encrypted.nonce)).rejects.toThrow();
  });

  it("round-trips a portable device identity without changing its public keys", async () => {
    const core = new WebCryptoMessagingCore();
    const identity = await core.createIdentity();
    identity.mlsState = new Uint8Array([4, 5, 6]);
    identity.accountCredential = "a".repeat(43);
    const before = await core.exportPublicIdentity(identity);
    const restored = await core.importPortableIdentity(await core.exportPortableIdentity(identity));
    expect(restored.deviceId).toBe(identity.deviceId);
    expect(Array.from(restored.mlsState ?? [])).toEqual([4, 5, 6]);
    expect(restored.accountCredential).toBe("a".repeat(43));
    expect(await core.exportPublicIdentity(restored)).toEqual(before);
    const message = new TextEncoder().encode("portable identity");
    const signature = await core.sign(restored, message);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, restored.signingPublicKey, decodeBase64Url(signature), message)).toBe(true);
  });

  it("transfers an account credential only to the exact linked device and context", async () => {
    const core = new WebCryptoMessagingCore();
    const [target, outsider] = await Promise.all([core.createIdentity(), core.createIdentity()]);
    const targetKeys = await core.exportPublicIdentity(target);
    const context = { linkId: "link_0123456789abcdef", sourceDeviceId: "source-device", targetDeviceId: target.deviceId };
    const envelope = await sealAccountCredential("z".repeat(43), context, targetKeys.encryption_key);
    expect(await openAccountCredential(envelope, context, target)).toBe("z".repeat(43));
    await expect(openAccountCredential(envelope, { ...context, linkId: "link_other_0123456789" }, target)).rejects.toThrow("authentication failed");
    await expect(openAccountCredential(envelope, { ...context, targetDeviceId: outsider.deviceId }, outsider)).rejects.toThrow("authentication failed");
    const bytes = decodeBase64Url(envelope); bytes[bytes.length - 2] ^= 1;
    await expect(openAccountCredential(btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), context, target)).rejects.toThrow();
  });

  it("renders a stable fingerprint and a deterministic device-link claim transcript", async () => {
    const core = new WebCryptoMessagingCore();
    const first = await core.createIdentity(); const second = await core.createIdentity();
    const firstKeys = await core.exportPublicIdentity(first); const secondKeys = await core.exportPublicIdentity(second);
    const signing = JSON.parse(firstKeys.signing_key) as JsonWebKey;
    const reordered = JSON.stringify({ y: signing.y, x: signing.x, crv: signing.crv, kty: signing.kty, ext: false, key_ops: [] });
    const stable = await deviceFingerprint(firstKeys.signing_key, firstKeys.encryption_key);
    expect(await deviceFingerprint(reordered, firstKeys.encryption_key)).toBe(stable);
    expect(await deviceFingerprint(secondKeys.signing_key, firstKeys.encryption_key)).not.toBe(stable);
    expect(stable).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){7}$/);
    expect(new TextDecoder().decode(deviceLinkClaimBytes("link", "device", "access-hash", "device-hash")))
      .toBe('{"version":2,"link_id":"link","device_id":"device","access_token_hash":"access-hash","device_credential_hash":"device-hash"}');
  });

  it("wraps an archive key independently to each active device", async () => {
    const core = new WebCryptoMessagingCore();
    const [alice, bob, outsider] = await Promise.all([core.createIdentity(), core.createIdentity(), core.createIdentity()]);
    const [aliceKeys, bobKeys] = await Promise.all([core.exportPublicIdentity(alice), core.exportPublicIdentity(bob)]);
    const context = { room_id: "!archive:example.com", segment_id: "segment_00000001", start_seq: 1, end_seq: 50 };
    const segmentKey = crypto.getRandomValues(new Uint8Array(32));
    const manifest = await sealArchiveSegmentKey(context, segmentKey, [
      { device_id: alice.deviceId, encryption_key: aliceKeys.encryption_key },
      { device_id: bob.deviceId, encryption_key: bobKeys.encryption_key },
    ]);

    expect(await openArchiveSegmentKey(manifest, context, alice)).toEqual(segmentKey);
    expect(await openArchiveSegmentKey(manifest, context, bob)).toEqual(segmentKey);
    await expect(openArchiveSegmentKey(manifest, context, outsider)).rejects.toThrow("not available");
  });

  it("binds archive key envelopes to the exact segment range", async () => {
    const core = new WebCryptoMessagingCore(); const identity = await core.createIdentity();
    const keys = await core.exportPublicIdentity(identity);
    const context = { room_id: "!archive:example.com", segment_id: "segment_00000002", start_seq: 51, end_seq: 100 };
    const manifest = await sealArchiveSegmentKey(context, crypto.getRandomValues(new Uint8Array(32)), [
      { device_id: identity.deviceId, encryption_key: keys.encryption_key },
    ]);
    await expect(openArchiveSegmentKey(manifest, { ...context, end_seq: 101 }, identity)).rejects.toThrow("authentication failed");
    const tampered = manifest.slice(); tampered[tampered.length - 3] ^= 1;
    await expect(openArchiveSegmentKey(tampered, context, identity)).rejects.toThrow();
  });
});
