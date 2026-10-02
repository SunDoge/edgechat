import { decodeBase64Url, encodeBase64Url, type DeviceIdentity } from "@edgechat/messaging-core";
import { roomEventTypes, type RoomEvent, type RoomId } from "@edgechat/protocol";
import { compress as zstdCompress, decompress as zstdDecompress, init as initZrip } from "@paddor/zrip";

const MAGIC = new Uint8Array([0x45, 0x43, 0x52, 0x45, 0x43, 0x31, 0x00, 0x00]); // ECREC1
const MAX_EVENTS = 500;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let zripReady: Promise<void> | null = null;

export type RoomPeerRecoveryContext = {
  recoveryId: string; roomId: RoomId; sourceDeviceId: string; targetDeviceId: string; afterSeq: number; throughSeq: number;
};
type RecoveryHeader = {
  format: "edgechat-room-peer-recovery"; version: 1; compression: "zstd";
  recovery_id: string; room_id: RoomId; source_device_id: string; target_device_id: string;
  after_seq: number; through_seq: number; event_count: number; plaintext_bytes: number;
  source_encryption_key: JsonWebKey; salt: string; nonce: string;
};

function owned(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }
function u32(value: number): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes as Uint8Array<ArrayBuffer>; }
function readU32(bytes: Uint8Array): number { return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0); }
function publicKey(value: JsonWebKey | string): JsonWebKey {
  const key = typeof value === "string" ? JSON.parse(value) as JsonWebKey : value;
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") throw new Error("无效的设备加密公钥");
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true };
}
function samePublicKey(left: JsonWebKey, right: JsonWebKey): boolean {
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
}
function validateContext(context: RoomPeerRecoveryContext): void {
  if (!context.recoveryId || context.recoveryId.length > 128 || !context.roomId.startsWith("!") || !context.sourceDeviceId || !context.targetDeviceId
    || !Number.isSafeInteger(context.afterSeq) || context.afterSeq < 0 || !Number.isSafeInteger(context.throughSeq)
    || context.throughSeq <= context.afterSeq || context.throughSeq - context.afterSeq > MAX_EVENTS) throw new Error("无效的设备恢复范围");
}
function info(context: RoomPeerRecoveryContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(`edgechat/room-peer-recovery/v1|${context.recoveryId}|${context.roomId}|${context.sourceDeviceId}|${context.targetDeviceId}|${context.afterSeq}|${context.throughSeq}`) as Uint8Array<ArrayBuffer>;
}
async function recoveryKey(privateKey: CryptoKey, peer: CryptoKey, salt: Uint8Array<ArrayBuffer>, context: RoomPeerRecoveryContext, usages: KeyUsage[]): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: owned(salt), info: owned(info(context)) }, material,
    { name: "AES-GCM", length: 256 }, false, usages);
}
function validEvent(value: unknown, context: RoomPeerRecoveryContext, expectedSeq: number): value is RoomEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RoomEvent>;
  return event.room_id === context.roomId && event.seq === expectedSeq && typeof event.event_id === "string" && event.event_id.length > 0
    && typeof event.sender === "string" && event.sender.startsWith("@") && typeof event.device_id === "string" && event.device_id.length > 0
    && typeof event.created_at === "number" && Number.isSafeInteger(event.created_at) && typeof event.ciphertext === "string"
    && typeof event.signature === "string" && Boolean(event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata))
    && typeof event.type === "string" && (roomEventTypes as readonly string[]).includes(event.type);
}

export async function sealRoomPeerRecovery(events: RoomEvent[], context: RoomPeerRecoveryContext, source: DeviceIdentity,
  targetEncryptionKey: JsonWebKey | string): Promise<Blob> {
  validateContext(context);
  if (source.deviceId !== context.sourceDeviceId || events.length !== context.throughSeq - context.afterSeq || events.length > MAX_EVENTS
    || events.some((event, index) => !validEvent(event, context, context.afterSeq + index + 1))) throw new Error("本机恢复记录不完整或顺序错误");
  const plaintext = encoder.encode(JSON.stringify({ version: 1, events }));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("恢复记录超过单批 32 MiB 上限");
  await (zripReady ??= initZrip());
  const compressed = Uint8Array.from(zstdCompress(plaintext, 1)) as Uint8Array<ArrayBuffer>;
  const peer = await crypto.subtle.importKey("jwk", publicKey(targetEncryptionKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const salt = crypto.getRandomValues(new Uint8Array(16)); const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header: RecoveryHeader = {
    format: "edgechat-room-peer-recovery", version: 1, compression: "zstd", recovery_id: context.recoveryId, room_id: context.roomId,
    source_device_id: context.sourceDeviceId, target_device_id: context.targetDeviceId, after_seq: context.afterSeq, through_seq: context.throughSeq,
    event_count: events.length, plaintext_bytes: plaintext.length, source_encryption_key: await crypto.subtle.exportKey("jwk", source.encryptionPublicKey),
    salt: encodeBase64Url(salt), nonce: encodeBase64Url(nonce),
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const key = await recoveryKey(source.encryptionPrivateKey, peer, salt, context, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: headerBytes }, key, compressed);
  return new Blob([owned(MAGIC), owned(u32(headerBytes.length)), owned(headerBytes), ciphertext], { type: "application/vnd.edgechat.room-recovery" });
}

export async function openRoomPeerRecovery(bundle: Blob, expected: RoomPeerRecoveryContext, target: DeviceIdentity,
  expectedSourceEncryptionKey: JsonWebKey | string): Promise<RoomEvent[]> {
  validateContext(expected);
  if (target.deviceId !== expected.targetDeviceId || bundle.size < MAGIC.length + 4 + 16 || bundle.size > 34 * 1024 * 1024) throw new Error("设备恢复包无效");
  const prefix = new Uint8Array(await bundle.slice(0, MAGIC.length + 4).arrayBuffer());
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) throw new Error("设备恢复包无效");
  const headerLength = readU32(prefix.subarray(MAGIC.length));
  if (headerLength < 64 || headerLength > MAX_HEADER_BYTES || MAGIC.length + 4 + headerLength + 16 > bundle.size) throw new Error("设备恢复包无效");
  const headerBytes = new Uint8Array(await bundle.slice(MAGIC.length + 4, MAGIC.length + 4 + headerLength).arrayBuffer());
  let header: RecoveryHeader;
  try { header = JSON.parse(decoder.decode(headerBytes)) as RecoveryHeader; } catch { throw new Error("设备恢复包无效"); }
  if (header.format !== "edgechat-room-peer-recovery" || header.version !== 1 || header.compression !== "zstd"
    || header.recovery_id !== expected.recoveryId || header.room_id !== expected.roomId || header.source_device_id !== expected.sourceDeviceId
    || header.target_device_id !== expected.targetDeviceId || header.after_seq !== expected.afterSeq || header.through_seq !== expected.throughSeq
    || header.event_count !== expected.throughSeq - expected.afterSeq || !Number.isSafeInteger(header.plaintext_bytes)
    || header.plaintext_bytes < 1 || header.plaintext_bytes > MAX_PLAINTEXT_BYTES) throw new Error("设备恢复包与请求不匹配");
  const salt = decodeBase64Url(header.salt); const nonce = decodeBase64Url(header.nonce);
  if (salt.length !== 16 || nonce.length !== 12) throw new Error("设备恢复包无效");
  const headerSourceKey = publicKey(header.source_encryption_key);
  if (!samePublicKey(headerSourceKey, publicKey(expectedSourceEncryptionKey))) throw new Error("设备恢复包源身份不匹配");
  const peer = await crypto.subtle.importKey("jwk", headerSourceKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await recoveryKey(target.encryptionPrivateKey, peer, salt, expected, ["decrypt"]);
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    const compressed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: headerBytes }, key,
      await bundle.slice(MAGIC.length + 4 + headerLength).arrayBuffer()));
    await (zripReady ??= initZrip());
    plaintext = Uint8Array.from(zstdDecompress(compressed, { maxDecompressedSize: header.plaintext_bytes })) as Uint8Array<ArrayBuffer>;
  } catch { throw new Error("设备恢复包已损坏或不属于这台设备"); }
  if (plaintext.length !== header.plaintext_bytes) throw new Error("设备恢复包解压长度不匹配");
  let payload: { version?: unknown; events?: unknown };
  try { payload = JSON.parse(decoder.decode(plaintext)) as { version?: unknown; events?: unknown }; } catch { throw new Error("设备恢复包内容无效"); }
  if (payload.version !== 1 || !Array.isArray(payload.events) || payload.events.length !== header.event_count
    || payload.events.some((event, index) => !validEvent(event, expected, expected.afterSeq + index + 1))) throw new Error("设备恢复包事件不完整或顺序错误");
  return payload.events as RoomEvent[];
}
