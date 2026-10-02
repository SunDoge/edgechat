import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { clearIdentity, loadIdentity, saveIdentity } from "./vault";

describe("Dexie device vault", () => {
  afterEach(() => clearIdentity());

  it("round-trips the structured-cloned device identity without exporting private keys", async () => {
    const identity = await new WebCryptoMessagingCore().createIdentity();
    identity.mlsState = new Uint8Array([1, 2, 3]);

    await saveIdentity(identity);
    const restored = await loadIdentity();

    expect(restored?.deviceId).toBe(identity.deviceId);
    expect(Array.from(restored?.mlsState ?? [])).toEqual([1, 2, 3]);
    expect(restored?.signingPrivateKey).toBeInstanceOf(CryptoKey);
    expect(restored?.encryptionPrivateKey).toBeInstanceOf(CryptoKey);
  });

  it("clears only the current local identity", async () => {
    await saveIdentity(await new WebCryptoMessagingCore().createIdentity());
    await clearIdentity();
    await expect(loadIdentity()).resolves.toBeNull();
  });
});
