import { describe, expect, it } from "vitest";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { LocalComposerDraft } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { openComposerDraft, sealComposerDraft } from "./draft-sync";

const roomId = "!draft-sync-room1:example.com" as RoomId;

describe("cross-device encrypted drafts", () => {
  it("round-trips a signed draft and deletion tombstone", async () => {
    const core = new WebCryptoMessagingCore(); const source = await core.createIdentity(); const target = await core.createIdentity();
    const targetKey = await crypto.subtle.exportKey("jwk", target.encryptionPublicKey);
    const signingKey = await crypto.subtle.exportKey("jwk", source.signingPublicKey);
    const draft: LocalComposerDraft = { room_id: roomId, text_content: "unfinished private text", mode: "reply", target_message_id: "$message1:example.com", quote_text: null, updated_at: 42 };
    await expect(openComposerDraft(await sealComposerDraft(draft, roomId, 42, source, target.deviceId, targetKey), target, signingKey)).resolves.toEqual(draft);
    await expect(openComposerDraft(await sealComposerDraft(null, roomId, 43, source, target.deviceId, targetKey), target, signingKey)).resolves.toBeNull();
  });

  it("rejects ciphertext tampering", async () => {
    const core = new WebCryptoMessagingCore(); const source = await core.createIdentity(); const target = await core.createIdentity();
    const envelope = await sealComposerDraft(null, roomId, 44, source, target.deviceId, await crypto.subtle.exportKey("jwk", target.encryptionPublicKey));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;
    await expect(openComposerDraft(envelope, target, await crypto.subtle.exportKey("jwk", source.signingPublicKey))).rejects.toThrow(/signature/i);
  });
});
