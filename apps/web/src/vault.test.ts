import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { clearIdentity, loadIdentity, saveIdentity } from "./vault";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

describe("Dexie device vault", () => {
  afterEach(async () => { await clearIdentity(FIRST); await clearIdentity(SECOND); });

  it("round-trips the structured-cloned device identity without exporting private keys", async () => {
    const identity = await new WebCryptoMessagingCore().createIdentity();
    identity.mlsState = new Uint8Array([1, 2, 3]);

    await saveIdentity(FIRST, identity);
    const restored = await loadIdentity(FIRST);

    expect(restored?.deviceId).toBe(identity.deviceId);
    expect(Array.from(restored?.mlsState ?? [])).toEqual([1, 2, 3]);
    expect(restored?.signingPrivateKey).toBeInstanceOf(CryptoKey);
    expect(restored?.encryptionPrivateKey).toBeInstanceOf(CryptoKey);
  });

  it("isolates and clears only the selected local profile identity", async () => {
    const core = new WebCryptoMessagingCore();
    await saveIdentity(FIRST, await core.createIdentity());
    await saveIdentity(SECOND, await core.createIdentity());
    await clearIdentity(FIRST);
    await expect(loadIdentity(FIRST)).resolves.toBeNull();
    await expect(loadIdentity(SECOND)).resolves.not.toBeNull();
  });
});
