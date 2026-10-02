import { decodeBase64Url, encodeBase64Url, type DeviceIdentity } from "@edgechat/messaging-core";

const MAGIC = new Uint8Array([0x45, 0x43, 0x48, 0x49, 0x53, 0x54, 0x31, 0x00]); // ECHIST1\0
// Leave room for authenticated chunk/header overhead under the Worker's 64 MiB
// one-object cap.
const MAX_PLAINTEXT_BYTES = 60 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const DEVICE_HISTORY_SHARD_PLAINTEXT_BYTES = 16 * 1024 * 1024;

export type DeviceHistoryContext = { linkId: string; sourceDeviceId: string; targetDeviceId: string };
export type DeviceHistoryManifest = {
  transfer_id: string;
  plaintext_bytes: number;
  shard_plaintext_bytes: number;
  shard_count: number;
};
type Header = {
  format: "edgechat-device-history"; version: 1;
  link_id: string; source_device_id: string; target_device_id: string;
  source_encryption_key: JsonWebKey; salt: string; chunk_bytes: number; chunk_count: number; plaintext_bytes: number;
};

function u32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes;
}
function readU32(bytes: Uint8Array): number { return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0); }
function owned(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }
function aad(header: Uint8Array, index: number): ArrayBuffer {
  const value = new Uint8Array(header.length + 4); value.set(header); value.set(u32(index), header.length); return value.buffer;
}
function info(context: DeviceHistoryContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(`edgechat/device-history/v1|${context.linkId}|${context.sourceDeviceId}|${context.targetDeviceId}`) as Uint8Array<ArrayBuffer>;
}
function assertContext(value: string, label: string): void {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_!:@.$-]+$/.test(value)) throw new Error(`Invalid ${label}`);
}
function publicKey(value: JsonWebKey | string): JsonWebKey {
  const key = typeof value === "string" ? JSON.parse(value) as JsonWebKey : value;
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") throw new Error("Invalid target device key");
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true };
}
async function transferKey(privateKey: CryptoKey, peer: CryptoKey, salt: Uint8Array<ArrayBuffer>, context: DeviceHistoryContext, usages: KeyUsage[]): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: owned(salt), info: owned(info(context)) }, material, { name: "AES-GCM", length: 256 }, false, usages);
}

export async function sealDeviceHistory(snapshot: Blob, context: DeviceHistoryContext, sourceIdentity: DeviceIdentity, targetEncryptionKey: JsonWebKey | string, chunkBytes = 1024 * 1024): Promise<Blob> {
  assertContext(context.linkId, "link ID"); assertContext(context.sourceDeviceId, "source device ID"); assertContext(context.targetDeviceId, "target device ID");
  if (sourceIdentity.deviceId !== context.sourceDeviceId) throw new Error("Source device identity mismatch");
  if (snapshot.size < 1 || snapshot.size > MAX_PLAINTEXT_BYTES) throw new Error("本机历史超过 60 MiB，暂时无法随设备链接传输");
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 * 1024 || chunkBytes > 2 * 1024 * 1024) throw new Error("Invalid history chunk size");
  const peer = await crypto.subtle.importKey("jwk", publicKey(targetEncryptionKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header: Header = {
    format: "edgechat-device-history", version: 1, link_id: context.linkId, source_device_id: context.sourceDeviceId, target_device_id: context.targetDeviceId,
    source_encryption_key: await crypto.subtle.exportKey("jwk", sourceIdentity.encryptionPublicKey), salt: encodeBase64Url(salt), chunk_bytes: chunkBytes,
    chunk_count: Math.ceil(snapshot.size / chunkBytes), plaintext_bytes: snapshot.size,
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const key = await transferKey(sourceIdentity.encryptionPrivateKey, peer, salt, context, ["encrypt"]);
  const parts: BlobPart[] = [owned(MAGIC), owned(u32(headerBytes.length)), owned(headerBytes)];
  for (let index = 0; index < header.chunk_count; index += 1) {
    const plaintext = await snapshot.slice(index * chunkBytes, Math.min(snapshot.size, (index + 1) * chunkBytes)).arrayBuffer();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: owned(nonce), additionalData: aad(headerBytes, index) }, key, plaintext);
    parts.push(owned(u32(ciphertext.byteLength)), owned(nonce), ciphertext);
  }
  return new Blob(parts, { type: "application/vnd.edgechat.device-history" });
}

export async function openDeviceHistory(sealed: Blob, expected: DeviceHistoryContext, identity: DeviceIdentity): Promise<Blob> {
  if (sealed.size < MAGIC.length + 4 || sealed.size > MAX_PLAINTEXT_BYTES + 2 * 1024 * 1024) throw new Error("设备历史包无效");
  const prefix = new Uint8Array(await sealed.slice(0, MAGIC.length + 4).arrayBuffer());
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) throw new Error("设备历史包无效");
  const headerLength = readU32(prefix.subarray(MAGIC.length));
  if (headerLength < 64 || headerLength > MAX_HEADER_BYTES || MAGIC.length + 4 + headerLength >= sealed.size) throw new Error("设备历史包无效");
  const headerBytes = new Uint8Array(await sealed.slice(MAGIC.length + 4, MAGIC.length + 4 + headerLength).arrayBuffer());
  let header: Header;
  try { header = JSON.parse(decoder.decode(headerBytes)) as Header; } catch { throw new Error("设备历史包无效"); }
  if (header.format !== "edgechat-device-history" || header.version !== 1 || header.link_id !== expected.linkId || header.source_device_id !== expected.sourceDeviceId
    || header.target_device_id !== expected.targetDeviceId || header.target_device_id !== identity.deviceId || !Number.isSafeInteger(header.plaintext_bytes)
    || header.plaintext_bytes < 1 || header.plaintext_bytes > MAX_PLAINTEXT_BYTES || !Number.isSafeInteger(header.chunk_bytes) || header.chunk_bytes < 64 * 1024
    || header.chunk_bytes > 2 * 1024 * 1024 || header.chunk_count !== Math.ceil(header.plaintext_bytes / header.chunk_bytes)) throw new Error("设备历史包与本次链接不匹配");
  const salt = decodeBase64Url(header.salt);
  if (salt.length !== 16) throw new Error("设备历史包无效");
  const peer = await crypto.subtle.importKey("jwk", publicKey(header.source_encryption_key), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await transferKey(identity.encryptionPrivateKey, peer, salt, expected, ["decrypt"]);
  const parts: BlobPart[] = []; let offset = MAGIC.length + 4 + headerLength; let total = 0;
  try {
    for (let index = 0; index < header.chunk_count; index += 1) {
      if (offset + 16 > sealed.size) throw new Error("truncated");
      const record = new Uint8Array(await sealed.slice(offset, offset + 16).arrayBuffer());
      const length = readU32(record); const nonce = record.subarray(4, 16);
      if (length < 17 || length > header.chunk_bytes + 16 || offset + 16 + length > sealed.size) throw new Error("invalid record");
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: owned(nonce), additionalData: aad(headerBytes, index) }, key, await sealed.slice(offset + 16, offset + 16 + length).arrayBuffer());
      parts.push(plaintext); total += plaintext.byteLength; offset += 16 + length;
    }
  } catch { throw new Error("设备历史包已损坏或不属于这台设备"); }
  if (offset !== sealed.size || total !== header.plaintext_bytes) throw new Error("设备历史包不完整");
  return new Blob(parts, { type: "application/gzip" });
}

export function createDeviceHistoryManifest(snapshotBytes: number, shardBytes = DEVICE_HISTORY_SHARD_PLAINTEXT_BYTES): DeviceHistoryManifest {
  if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes < 1) throw new Error("本机历史快照为空");
  if (!Number.isSafeInteger(shardBytes) || shardBytes < 1024 * 1024 || shardBytes > 32 * 1024 * 1024) throw new Error("设备历史分片大小无效");
  const shardCount = Math.ceil(snapshotBytes / shardBytes);
  if (shardCount > 4096) throw new Error("本机历史超过设备链接迁移上限");
  return { transfer_id: encodeBase64Url(crypto.getRandomValues(new Uint8Array(18))), plaintext_bytes: snapshotBytes,
    shard_plaintext_bytes: shardBytes, shard_count: shardCount };
}

function shardContext(context: DeviceHistoryContext, transferId: string, index: number): DeviceHistoryContext {
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(transferId) || !Number.isSafeInteger(index) || index < 0 || index >= 4096) throw new Error("设备历史分片标识无效");
  return { ...context, linkId: `${context.linkId}.${transferId}.${index}` };
}

export async function sealDeviceHistoryShard(snapshot: Blob, manifest: DeviceHistoryManifest, index: number, context: DeviceHistoryContext,
  sourceIdentity: DeviceIdentity, targetEncryptionKey: JsonWebKey | string): Promise<Blob> {
  if (snapshot.size !== manifest.plaintext_bytes || index >= manifest.shard_count) throw new Error("设备历史快照与清单不匹配");
  const start = index * manifest.shard_plaintext_bytes;
  const end = Math.min(snapshot.size, start + manifest.shard_plaintext_bytes);
  return sealDeviceHistory(snapshot.slice(start, end), shardContext(context, manifest.transfer_id, index), sourceIdentity, targetEncryptionKey);
}

export async function openDeviceHistoryShard(sealed: Blob, manifest: DeviceHistoryManifest, index: number, context: DeviceHistoryContext,
  identity: DeviceIdentity): Promise<Blob> {
  if (index >= manifest.shard_count) throw new Error("设备历史分片超出清单范围");
  const opened = await openDeviceHistory(sealed, shardContext(context, manifest.transfer_id, index), identity);
  const expected = Math.min(manifest.shard_plaintext_bytes, manifest.plaintext_bytes - index * manifest.shard_plaintext_bytes);
  if (opened.size !== expected) throw new Error("设备历史分片长度与清单不匹配");
  return opened;
}
