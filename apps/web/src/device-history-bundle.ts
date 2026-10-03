import { DeviceHistoryTransferError } from "./device-history-transfer";

const MAGIC = new Uint8Array([0x45, 0x43, 0x42, 0x55, 0x4e, 0x44, 0x4c, 0x32]); // ECBUNDL2
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 100_000;
const SAFE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type BundleHeader = {
  format: "edgechat-device-history-bundle";
  version: 2 | 3;
  database_bytes: number;
  attachments: Array<{ id: string; bytes: number }>;
  segments?: Array<{ id: string; bytes: number }>;
};

function u32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes;
}

function readU32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
}

export async function createDeviceHistoryBundle(databaseSnapshot: Blob, attachments: Array<{ id: string; ciphertext: Blob }>, segments: Array<{ id: string; ciphertext: Blob }> = []): Promise<Blob> {
  if (databaseSnapshot.size < 1) throw new DeviceHistoryTransferError("invalid_snapshot");
  if (attachments.length > MAX_ATTACHMENTS || segments.length > MAX_ATTACHMENTS) throw new DeviceHistoryTransferError("transfer_limit");
  const seen = new Set<string>();
  for (const item of [...attachments, ...segments]) {
    if (!SAFE_ID.test(item.id) || item.ciphertext.size < 1 || seen.has(item.id)) throw new DeviceHistoryTransferError("invalid_snapshot");
    seen.add(item.id);
  }
  const header: BundleHeader = {
    format: "edgechat-device-history-bundle", version: 3, database_bytes: databaseSnapshot.size,
    attachments: attachments.map((attachment) => ({ id: attachment.id, bytes: attachment.ciphertext.size })),
    segments: segments.map((segment) => ({ id: segment.id, bytes: segment.ciphertext.size })),
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) throw new DeviceHistoryTransferError("transfer_limit");
  return new Blob([MAGIC.slice().buffer, u32(headerBytes.byteLength).buffer, headerBytes.slice().buffer, databaseSnapshot,
    ...attachments.map((attachment) => attachment.ciphertext), ...segments.map((segment) => segment.ciphertext)], { type: "application/vnd.edgechat.device-history-bundle" });
}

export async function openDeviceHistoryBundle(value: Blob): Promise<{ databaseSnapshot: Blob; attachments: Array<{ id: string; ciphertext: Blob }>; segments: Array<{ id: string; ciphertext: Blob }> }> {
  const prefixBytes = MAGIC.length + 4;
  if (value.size < prefixBytes) return { databaseSnapshot: value, attachments: [], segments: [] }; // legacy gzip-only snapshot
  const prefix = new Uint8Array(await value.slice(0, prefixBytes).arrayBuffer());
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) return { databaseSnapshot: value, attachments: [], segments: [] };
  const headerLength = readU32(prefix.subarray(MAGIC.length));
  if (headerLength < 32 || headerLength > MAX_HEADER_BYTES || prefixBytes + headerLength >= value.size) throw new DeviceHistoryTransferError("invalid_package");
  let parsedHeader: unknown;
  try { parsedHeader = JSON.parse(decoder.decode(await value.slice(prefixBytes, prefixBytes + headerLength).arrayBuffer())); }
  catch { throw new DeviceHistoryTransferError("invalid_package"); }
  if (!parsedHeader || typeof parsedHeader !== "object" || Array.isArray(parsedHeader)) throw new DeviceHistoryTransferError("invalid_package");
  const header = parsedHeader as BundleHeader;
  if (header.format !== "edgechat-device-history-bundle" || (header.version !== 2 && header.version !== 3) || !Number.isSafeInteger(header.database_bytes)
    || header.database_bytes < 1 || !Array.isArray(header.attachments) || header.attachments.length > MAX_ATTACHMENTS
    || (header.version === 3 && (!Array.isArray(header.segments) || header.segments.length > MAX_ATTACHMENTS))) throw new DeviceHistoryTransferError("invalid_package");
  const segmentItems = header.version === 3 ? header.segments! : [];
  const seen = new Set<string>();
  for (const item of [...header.attachments, ...segmentItems]) {
    if (!item || !SAFE_ID.test(item.id) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || seen.has(item.id)) throw new DeviceHistoryTransferError("invalid_package");
    seen.add(item.id);
  }
  let offset = prefixBytes + headerLength;
  const databaseEnd = offset + header.database_bytes;
  if (!Number.isSafeInteger(databaseEnd) || databaseEnd > value.size) throw new DeviceHistoryTransferError("incomplete_package");
  const databaseSnapshot = value.slice(offset, databaseEnd, "application/gzip"); offset = databaseEnd;
  const attachments = header.attachments.map((item) => {
    const end = offset + item.bytes;
    if (!Number.isSafeInteger(end) || end > value.size) throw new DeviceHistoryTransferError("incomplete_package");
    const ciphertext = value.slice(offset, end, "application/octet-stream"); offset = end;
    return { id: item.id, ciphertext };
  });
  const segments = segmentItems.map((item) => {
    const end = offset + item.bytes;
    if (!Number.isSafeInteger(end) || end > value.size) throw new DeviceHistoryTransferError("incomplete_package");
    const ciphertext = value.slice(offset, end, "application/octet-stream"); offset = end;
    return { id: item.id, ciphertext };
  });
  if (offset !== value.size) throw new DeviceHistoryTransferError("incomplete_package");
  return { databaseSnapshot, attachments, segments };
}
