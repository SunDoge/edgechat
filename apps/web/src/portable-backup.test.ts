import { describe, expect, it } from "vitest";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { createPortableBackupBlob, readPortableBackup } from "./portable-backup";

describe("portable encrypted backup", () => {
  it("round-trips multiple authenticated chunks and rejects a changed tag", async () => {
    const core = new WebCryptoMessagingCore();
    const identity = await core.createIdentity();
    identity.accountCredential = "a".repeat(43);
    identity.mlsState = Uint8Array.from({ length: 90_000 }, (_, index) => index % 251);
    const portable = await core.exportPortableIdentity(identity);
    const database = new Blob([Uint8Array.from({ length: 100_000 }, (_, index) => index % 239)]);
    const checkpoint = "checkpoint_abcdefghijklmnopqrstuvwxyz123456";
    const backup = await createPortableBackupBlob({ databaseSnapshot: database, identity: portable, userId: "@alice:example.com", serverOrigin: "https://chat.example.com", backupCheckpoint: checkpoint, password: "correct horse battery staple" }, { chunkBytes: 64 * 1024, iterations: 100_000 });
    const restored = await readPortableBackup(backup, "correct horse battery staple", "https://chat.example.com");
    expect(restored.userId).toBe("@alice:example.com");
    expect(restored.identity.device_id).toBe(identity.deviceId);
    expect(restored.backupCheckpoint).toBe(checkpoint);
    expect(new Uint8Array(await restored.databaseSnapshot.arrayBuffer())).toEqual(new Uint8Array(await database.arrayBuffer()));

    const tampered = new Uint8Array(await backup.arrayBuffer());
    tampered[tampered.length - 1] ^= 1;
    await expect(readPortableBackup(new Blob([tampered]), "correct horse battery staple")).rejects.toThrow("密码错误");
    await expect(readPortableBackup(backup, "wrong password that is long enough")).rejects.toThrow("密码错误");
  });
});
