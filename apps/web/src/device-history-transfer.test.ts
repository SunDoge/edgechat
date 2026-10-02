import { describe, expect, it } from "vitest";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { createDeviceHistoryManifest, openDeviceHistory, openDeviceHistoryShard, sealDeviceHistory, sealDeviceHistoryShard } from "./device-history-transfer";

describe("device history transfer", () => {
  it("seals a chunked snapshot to exactly one target device and authenticates tampering", async () => {
    const core = new WebCryptoMessagingCore(); const source = await core.createIdentity(); const target = await core.createIdentity(); const wrong = await core.createIdentity();
    const targetKeys = await core.exportPublicIdentity(target);
    const context = { linkId: "link-history-123", sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId };
    const plaintext = new Blob([Uint8Array.from({ length: 180_000 }, (_, index) => index % 251)]);
    const sealed = await sealDeviceHistory(plaintext, context, source, targetKeys.encryption_key, 64 * 1024);
    expect(new Uint8Array(await (await openDeviceHistory(sealed, context, target)).arrayBuffer())).toEqual(new Uint8Array(await plaintext.arrayBuffer()));
    await expect(openDeviceHistory(sealed, { ...context, linkId: "another-link" }, target)).rejects.toThrow("不匹配");
    await expect(openDeviceHistory(sealed, { ...context, targetDeviceId: wrong.deviceId }, wrong)).rejects.toThrow();
    const damaged = new Uint8Array(await sealed.arrayBuffer()); damaged[damaged.length - 1] ^= 1;
    await expect(openDeviceHistory(new Blob([damaged]), context, target)).rejects.toThrow("损坏");
  });

  it("encrypts independently authenticated resumable shards and rejoins the snapshot", async () => {
    const core = new WebCryptoMessagingCore(); const source = await core.createIdentity(); const target = await core.createIdentity();
    const targetKeys = await core.exportPublicIdentity(target);
    const context = { linkId: "link-shards-123", sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId };
    const snapshot = new Blob([Uint8Array.from({ length: 2_500_000 }, (_, index) => index % 239)]);
    const manifest = createDeviceHistoryManifest(snapshot.size, 1024 * 1024);
    const opened: Blob[] = [];
    for (let index = 0; index < manifest.shard_count; index += 1) {
      const sealed = await sealDeviceHistoryShard(snapshot, manifest, index, context, source, targetKeys.encryption_key);
      opened.push(await openDeviceHistoryShard(sealed, manifest, index, context, target));
      if (index === 1) await expect(openDeviceHistoryShard(sealed, manifest, 0, context, target)).rejects.toThrow();
    }
    expect(new Uint8Array(await new Blob(opened).arrayBuffer())).toEqual(new Uint8Array(await snapshot.arrayBuffer()));
  });
});
