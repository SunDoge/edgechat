import type { LocalComposerDraft } from "@edgechat/db";
import { decodeBase64Url, encodeBase64Url, type DeviceIdentity } from "@edgechat/messaging-core";
import { canonicalDraftEnvelopeBytes, draftEnvelopeAadBytes, isNamespacedMessageId, isNamespacedRoomId, type DraftEnvelope, type RoomId } from "@edgechat/protocol";

type DraftPayload = {
  version: 1;
  draft: null | Pick<LocalComposerDraft, "text_content" | "mode" | "target_message_id" | "quote_text">;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function publicKey(value: JsonWebKey): JsonWebKey {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") throw new Error("Invalid draft device key");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true };
}

function context(envelope: Pick<DraftEnvelope, "room_id" | "source_device_id" | "target_device_id" | "client_updated_at">): Uint8Array<ArrayBuffer> {
  return encoder.encode(`edgechat/draft/v1|${envelope.room_id}|${envelope.source_device_id}|${envelope.target_device_id}|${envelope.client_updated_at}`) as Uint8Array<ArrayBuffer>;
}

async function wrappingKey(privateKey: CryptoKey, peer: CryptoKey, salt: Uint8Array, envelope: Pick<DraftEnvelope, "room_id" | "source_device_id" | "target_device_id" | "client_updated_at">, usages: KeyUsage[]): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: owned(salt), info: context(envelope) }, material,
    { name: "AES-GCM", length: 256 }, false, usages);
}

export async function sealComposerDraft(draft: LocalComposerDraft | null, roomId: RoomId, clientUpdatedAt: number, source: DeviceIdentity, targetDeviceId: string, targetEncryptionKey: JsonWebKey): Promise<DraftEnvelope> {
  if (!isNamespacedRoomId(roomId) || !Number.isSafeInteger(clientUpdatedAt) || clientUpdatedAt < 1 || !targetDeviceId || targetDeviceId.length > 96) throw new Error("Invalid draft context");
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const peer = await crypto.subtle.importKey("jwk", publicKey(targetEncryptionKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const salt = crypto.getRandomValues(new Uint8Array(16)); const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    version: 1 as const, room_id: roomId, source_device_id: source.deviceId, target_device_id: targetDeviceId, client_updated_at: clientUpdatedAt,
    ephemeral_key: await crypto.subtle.exportKey("jwk", ephemeral.publicKey), salt: encodeBase64Url(salt), nonce: encodeBase64Url(nonce),
  };
  const payload: DraftPayload = { version: 1, draft: draft ? {
    text_content: draft.text_content, mode: draft.mode, target_message_id: draft.target_message_id, quote_text: draft.quote_text,
  } : null };
  const plaintext = encoder.encode(JSON.stringify(payload));
  if (plaintext.byteLength > 64 * 1024) throw new Error("Draft is too large");
  const key = await wrappingKey(ephemeral.privateKey, peer, salt, header, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: draftEnvelopeAadBytes(header) }, key, plaintext);
  const unsigned = { ...header, ciphertext: encodeBase64Url(ciphertext) };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, source.signingPrivateKey, canonicalDraftEnvelopeBytes(unsigned));
  return { ...unsigned, signature: encodeBase64Url(signature) };
}

function validPayload(value: unknown, envelope: DraftEnvelope): value is DraftPayload {
  if (!value || typeof value !== "object" || (value as DraftPayload).version !== 1) return false;
  const draft = (value as DraftPayload).draft;
  if (draft === null) return true;
  if (!draft || typeof draft !== "object" || typeof draft.text_content !== "string" || draft.text_content.length > 16_000
    || !new Set(["message", "reply", "quote", "edit"]).has(draft.mode)
    || (draft.target_message_id !== null && !isNamespacedMessageId(draft.target_message_id))
    || (draft.quote_text !== null && (typeof draft.quote_text !== "string" || draft.quote_text.length > 2_000))) return false;
  if ((draft.mode === "reply" || draft.mode === "quote" || draft.mode === "edit") && !draft.target_message_id) return false;
  if (draft.mode === "quote" && !draft.quote_text) return false;
  return envelope.client_updated_at > 0;
}

export async function openComposerDraft(envelope: DraftEnvelope, target: DeviceIdentity, sourceSigningKey: JsonWebKey): Promise<LocalComposerDraft | null> {
  if (envelope.version !== 1 || envelope.target_device_id !== target.deviceId || !isNamespacedRoomId(envelope.room_id)) throw new Error("Draft envelope is for another device");
  const signing = await crypto.subtle.importKey("jwk", publicKey(sourceSigningKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const { signature, ...unsigned } = envelope;
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signing, decodeBase64Url(signature), canonicalDraftEnvelopeBytes(unsigned)))) throw new Error("Draft signature is invalid");
  const peer = await crypto.subtle.importKey("jwk", publicKey(envelope.ephemeral_key), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const salt = decodeBase64Url(envelope.salt); const nonce = decodeBase64Url(envelope.nonce);
  if (salt.byteLength !== 16 || nonce.byteLength !== 12) throw new Error("Draft envelope parameters are invalid");
  const key = await wrappingKey(target.encryptionPrivateKey, peer, salt, envelope, ["decrypt"]);
  const header = { version: envelope.version, room_id: envelope.room_id, source_device_id: envelope.source_device_id, target_device_id: envelope.target_device_id,
    client_updated_at: envelope.client_updated_at, ephemeral_key: envelope.ephemeral_key, salt: envelope.salt, nonce: envelope.nonce };
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: draftEnvelopeAadBytes(header) }, key, decodeBase64Url(envelope.ciphertext));
  const payload: unknown = JSON.parse(decoder.decode(plaintext));
  if (!validPayload(payload, envelope)) throw new Error("Draft payload is invalid");
  return payload.draft ? { room_id: envelope.room_id, ...payload.draft, updated_at: envelope.client_updated_at } : null;
}
