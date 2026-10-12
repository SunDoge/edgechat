import { describe, expect, it } from "vitest";
import { ATTACHMENT_PREFIX_BYTES, decodeBase64Url, deviceFingerprint, deviceLinkClaimBytes, openAccountCredential, openArchiveSegmentKey, parseEncryptedAttachmentManifest, readEncryptedAttachmentManifest, sealAccountCredential, sealArchiveSegmentKey, WebCryptoMessagingCore } from "./index";

describe("device support crypto", () => {
  it("encrypts attachments and rejects a changed authentication tag", async () => {
    const core = new WebCryptoMessagingCore();
    const attachmentId = "A".repeat(32);
    const encrypted = await core.encryptAttachment(new TextEncoder().encode("attachment").buffer, attachmentId);
    expect(new TextDecoder().decode(await core.decryptAttachment(encrypted.ciphertext, encrypted.key, encrypted.nonce, attachmentId))).toBe("attachment");
    expect(new TextDecoder().decode(await core.decryptAttachment(encrypted.ciphertext, encrypted.key, encrypted.nonce, "G".repeat(32))))
      .toBe("attachment"); // zero-copy forwarding may replace the server-side ACL locator
    const tampered = encrypted.ciphertext.slice(0); new Uint8Array(tampered)[0] ^= 1;
    await expect(core.decryptAttachment(tampered, encrypted.key, encrypted.nonce, attachmentId)).rejects.toThrow();
  });

  it("range-decrypts only the independently authenticated chunks covering the requested plaintext", async () => {
    const core = new WebCryptoMessagingCore(); const attachmentId = "R".repeat(32);
    const plaintext = Uint8Array.from({ length: 1024 * 1024 + 777 }, (_, index) => index % 251);
    const encrypted = await core.encryptAttachment(plaintext.buffer, attachmentId);
    expect(encrypted.chunkCount).toBeGreaterThan(1);
    const ciphertext = new Uint8Array(encrypted.ciphertext); const reads: Array<[number, number]> = [];
    const source = async (offset: number, length: number) => { reads.push([offset, length]); return ciphertext.slice(offset, offset + length); };
    const offset = encrypted.chunkSize - 19; const length = 91;
    const opened = await core.decryptAttachmentRange(source, encrypted.key, encrypted.nonce, attachmentId, offset, length);
    expect(new Uint8Array(opened)).toEqual(plaintext.slice(offset, offset + length));
    expect(reads[0]).toEqual([0, ATTACHMENT_PREFIX_BYTES]);
    expect(reads).toHaveLength(3); // prefix, encrypted manifest, then the two contiguous data chunks
    expect(reads[2]![1]).toBeLessThan(encrypted.ciphertext.byteLength);
  });

  it("authenticates the strict encrypted manifest and every chunk independently", async () => {
    const core = new WebCryptoMessagingCore(); const attachmentId = "T".repeat(32);
    const plaintext = new Uint8Array(1024 * 1024 + 1).fill(7);
    const encrypted = await core.encryptAttachment(plaintext.buffer, attachmentId);
    const original = new Uint8Array(encrypted.ciphertext);
    const source = async (offset: number, length: number) => original.slice(offset, offset + length);
    const { dataOffset, manifest } = await readEncryptedAttachmentManifest(source, encrypted.key, encrypted.nonce, attachmentId);
    expect(parseEncryptedAttachmentManifest(manifest)).toEqual(manifest);
    expect(() => parseEncryptedAttachmentManifest({ ...manifest, unexpected: true })).toThrow("manifest JSON");
    const tampered = original.slice(); tampered[dataOffset + manifest.chunks[1]!.offset] ^= 1;
    await expect(core.decryptAttachmentRange(async (offset, length) => tampered.slice(offset, offset + length), encrypted.key,
      encrypted.nonce, attachmentId, manifest.chunk_size, 1)).rejects.toThrow("chunk authentication failed");
    const badManifest = original.slice(); badManifest[ATTACHMENT_PREFIX_BYTES] ^= 1;
    await expect(readEncryptedAttachmentManifest(async (offset, length) => badManifest.slice(offset, offset + length),
      encrypted.key, encrypted.nonce, attachmentId)).rejects.toThrow("manifest authentication failed");
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
