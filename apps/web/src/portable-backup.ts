import { decodeBase64Url, encodeBase64Url, type PortableDeviceIdentity } from "@edgechat/messaging-core";
import { UserFacingError } from "./user-facing-error";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAGIC = encoder.encode("EDGEBK02");
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const MAX_BACKUP_BYTES = 2_147_483_648;
const MAX_HEADER_BYTES = 16_384;

type BackupHeader = {
  format: "edgechat-portable-backup";
  version: 2;
  created_at: number;
  kdf: { name: "PBKDF2-SHA-256"; salt: string; iterations: number };
  cipher: "AES-256-GCM-chunks";
  chunk_bytes: number;
  chunk_count: number;
  plaintext_bytes: number;
};

type BackupMetadata = {
  version: 2;
  user_id: string;
  server_origin: string;
  payload_format: "edgechat-device-history-bundle-v3";
  payload_bytes: number;
  backup_checkpoint: string;
  identity: PortableDeviceIdentity;
};

export type PortableBackupContents = {
  userId: string;
  serverOrigin: string;
  identity: PortableDeviceIdentity;
  historyBundle: Blob;
  createdAt: number;
  backupCheckpoint: string;
};

type BackupOptions = { chunkBytes?: number; iterations?: number };
type ByteWriter = (bytes: Uint8Array) => Promise<void>;
export type PortableBackupPayloadContents = Omit<PortableBackupContents, "historyBundle"> & { payloadBytes: number };

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("Backup field is out of range");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function readU32(bytes: Uint8Array): number {
  if (bytes.byteLength !== 4) throw UserFacingError.localized("backup.error.invalidFile");
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

function aad(headerBytes: Uint8Array, chunkIndex: number): Uint8Array {
  const value = new Uint8Array(MAGIC.length + headerBytes.length + 4);
  value.set(MAGIC, 0); value.set(headerBytes, MAGIC.length); value.set(u32(chunkIndex), MAGIC.length + headerBytes.length);
  return value;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: ownedBuffer(salt), iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function validateHeader(value: unknown): BackupHeader {
  if (!value || typeof value !== "object") throw UserFacingError.localized("backup.error.invalidFile");
  const header = value as Partial<BackupHeader>;
  if (header.format !== "edgechat-portable-backup" || header.version !== 2 || header.cipher !== "AES-256-GCM-chunks"
    || header.kdf?.name !== "PBKDF2-SHA-256" || typeof header.kdf.salt !== "string"
    || !Number.isSafeInteger(header.kdf.iterations) || Number(header.kdf.iterations) < 100_000 || Number(header.kdf.iterations) > 2_000_000
    || !Number.isSafeInteger(header.chunk_bytes) || Number(header.chunk_bytes) < 64 * 1024 || Number(header.chunk_bytes) > 2 * 1024 * 1024
    || !Number.isSafeInteger(header.chunk_count) || Number(header.chunk_count) < 1 || Number(header.chunk_count) > 32_768
    || !Number.isSafeInteger(header.plaintext_bytes) || Number(header.plaintext_bytes) < 5 || Number(header.plaintext_bytes) > MAX_BACKUP_BYTES
    || !Number.isFinite(header.created_at)) throw UserFacingError.localized("backup.error.invalidFile");
  return header as BackupHeader;
}

function validateMetadata(value: unknown, expectedOrigin?: string): BackupMetadata {
  if (!value || typeof value !== "object") throw UserFacingError.localized("backup.error.invalidContents");
  const metadata = value as Partial<BackupMetadata>;
  const portableIdentity = metadata.identity as Partial<PortableDeviceIdentity> | undefined;
  if (metadata.version !== 2 || metadata.payload_format !== "edgechat-device-history-bundle-v3"
    || !Number.isSafeInteger(metadata.payload_bytes) || Number(metadata.payload_bytes) <= 0 || Number(metadata.payload_bytes) > MAX_BACKUP_BYTES
    || typeof metadata.user_id !== "string" || typeof metadata.server_origin !== "string"
    || typeof metadata.backup_checkpoint !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(metadata.backup_checkpoint) || !portableIdentity
    || typeof portableIdentity.device_id !== "string" || portableIdentity.device_id.length === 0
    || portableIdentity.version !== 2 || typeof portableIdentity.signing_private_key !== "object"
    || typeof portableIdentity.encryption_private_key !== "object" || typeof portableIdentity.mls_state !== "string"
    || typeof portableIdentity.account_credential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(portableIdentity.account_credential)) throw UserFacingError.localized("backup.error.invalidContents");
  if (expectedOrigin && metadata.server_origin !== expectedOrigin) throw UserFacingError.localized("backup.error.wrongServer");
  return metadata as BackupMetadata;
}

export async function writePortableBackup(
  input: { historyBundle: Blob; identity: PortableDeviceIdentity; userId: string; serverOrigin: string; backupCheckpoint: string; password: string },
  write: ByteWriter,
  options: BackupOptions = {},
): Promise<{ createdAt: number; bytes: number }> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (input.password.length < 12) throw UserFacingError.localized("backup.error.passwordTooShort");
  if (input.historyBundle.size === 0 || input.historyBundle.size > MAX_BACKUP_BYTES) throw UserFacingError.localized("backup.error.payloadInvalid");
  if (chunkBytes < 64 * 1024 || chunkBytes > 2 * 1024 * 1024 || iterations < 100_000 || iterations > 2_000_000) throw new Error("Invalid backup parameters");

  const metadata = encoder.encode(JSON.stringify({
    version: 2,
    user_id: input.userId,
    server_origin: input.serverOrigin,
    payload_format: "edgechat-device-history-bundle-v3",
    payload_bytes: input.historyBundle.size,
    backup_checkpoint: input.backupCheckpoint,
    identity: input.identity,
  } satisfies BackupMetadata));
  const payload = new Blob([ownedBuffer(u32(metadata.length)), ownedBuffer(metadata), input.historyBundle]);
  if (payload.size > MAX_BACKUP_BYTES) throw UserFacingError.localized("backup.error.payloadTooLarge");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const createdAt = Date.now();
  const header: BackupHeader = {
    format: "edgechat-portable-backup", version: 2, created_at: createdAt,
    kdf: { name: "PBKDF2-SHA-256", salt: encodeBase64Url(salt), iterations },
    cipher: "AES-256-GCM-chunks", chunk_bytes: chunkBytes,
    chunk_count: Math.ceil(payload.size / chunkBytes), plaintext_bytes: payload.size,
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const key = await deriveKey(input.password, salt, iterations);
  await write(MAGIC); await write(u32(headerBytes.length)); await write(headerBytes);
  let written = MAGIC.length + 4 + headerBytes.length;
  for (let index = 0; index < header.chunk_count; index += 1) {
    const plaintext = await payload.slice(index * chunkBytes, Math.min(payload.size, (index + 1) * chunkBytes)).arrayBuffer();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ownedBuffer(nonce), additionalData: ownedBuffer(aad(headerBytes, index)) }, key, plaintext));
    await write(u32(ciphertext.length)); await write(nonce); await write(ciphertext);
    written += 4 + nonce.length + ciphertext.length;
  }
  return { createdAt, bytes: written };
}

export async function createPortableBackupBlob(
  input: Parameters<typeof writePortableBackup>[0],
  options?: BackupOptions,
): Promise<Blob> {
  const parts: BlobPart[] = [];
  await writePortableBackup(input, async (bytes) => { parts.push(bytes.slice().buffer); }, options);
  return new Blob(parts, { type: "application/vnd.edgechat.backup" });
}

export async function streamPortableBackupPayload(
  file: Blob,
  password: string,
  write: ByteWriter,
  expectedOrigin?: string,
): Promise<PortableBackupPayloadContents> {
  if (file.size < MAGIC.length + 4 || file.size > MAX_BACKUP_BYTES + 2 * 1024 * 1024) throw UserFacingError.localized("backup.error.invalidFile");
  const prefix = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) throw UserFacingError.localized("backup.error.invalidFile");
  const headerLength = readU32(prefix.subarray(MAGIC.length));
  if (headerLength < 32 || headerLength > MAX_HEADER_BYTES || MAGIC.length + 4 + headerLength > file.size) throw UserFacingError.localized("backup.error.invalidFile");
  const headerBytes = new Uint8Array(await file.slice(MAGIC.length + 4, MAGIC.length + 4 + headerLength).arrayBuffer());
  let parsedHeader: unknown;
  try { parsedHeader = JSON.parse(decoder.decode(headerBytes)); } catch { throw UserFacingError.localized("backup.error.invalidFile"); }
  const header = validateHeader(parsedHeader);
  const salt = decodeBase64Url(header.kdf.salt);
  if (salt.length !== 16) throw UserFacingError.localized("backup.error.invalidFile");
  const key = await deriveKey(password, salt, header.kdf.iterations);
  let offset = MAGIC.length + 4 + headerLength;
  let plaintextBytes = 0;
  let metadataParts: Uint8Array[] = [];
  let bufferedMetadataBytes = 0;
  let metadataLength: number | null = null;
  let metadata: BackupMetadata | null = null;
  let payloadBytes = 0;
  for (let index = 0; index < header.chunk_count; index += 1) {
    if (offset + 16 > file.size) throw UserFacingError.localized("backup.error.passwordOrDamage");
    const record = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    const ciphertextLength = readU32(record.subarray(0, 4));
    if (ciphertextLength < 17 || ciphertextLength > header.chunk_bytes + 16 || offset + 16 + ciphertextLength > file.size) throw UserFacingError.localized("backup.error.passwordOrDamage");
    const nonce = record.subarray(4, 16);
    const ciphertext = await file.slice(offset + 16, offset + 16 + ciphertextLength).arrayBuffer();
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ownedBuffer(nonce), additionalData: ownedBuffer(aad(headerBytes, index)) }, key, ciphertext));
    } catch { throw UserFacingError.localized("backup.error.passwordOrDamage"); }
    plaintextBytes += plaintext.byteLength; offset += 16 + ciphertextLength;
    if (!metadata) {
      metadataParts.push(plaintext); bufferedMetadataBytes += plaintext.byteLength;
      if (metadataLength === null && bufferedMetadataBytes >= 4) {
        const lengthBytes = new Uint8Array(4); let lengthOffset = 0;
        for (const part of metadataParts) {
          const take = Math.min(part.byteLength, 4 - lengthOffset);
          lengthBytes.set(part.subarray(0, take), lengthOffset); lengthOffset += take;
          if (lengthOffset === 4) break;
        }
        metadataLength = readU32(lengthBytes);
        if (metadataLength < 32 || metadataLength > Math.min(16 * 1024 * 1024, header.plaintext_bytes - 4)) throw UserFacingError.localized("backup.error.invalidContents");
      }
      if (metadataLength !== null && bufferedMetadataBytes >= 4 + metadataLength) {
        const metadataBytes = new Uint8Array(bufferedMetadataBytes); let bufferedOffset = 0;
        for (const part of metadataParts) { metadataBytes.set(part, bufferedOffset); bufferedOffset += part.byteLength; }
        let parsed: unknown;
        try { parsed = JSON.parse(decoder.decode(metadataBytes.subarray(4, 4 + metadataLength))); }
        catch { throw UserFacingError.localized("backup.error.invalidContents"); }
        metadata = validateMetadata(parsed, expectedOrigin);
        const payloadStart = 4 + metadataLength;
        if (metadataBytes.byteLength > payloadStart) {
          const bytes = metadataBytes.subarray(payloadStart);
          await write(bytes); payloadBytes += bytes.byteLength;
        }
        metadataParts = []; bufferedMetadataBytes = 0;
      }
    } else {
      await write(plaintext); payloadBytes += plaintext.byteLength;
    }
  }
  if (offset !== file.size || plaintextBytes !== header.plaintext_bytes) throw UserFacingError.localized("backup.error.incompleteFile");
  if (!metadata || payloadBytes !== metadata.payload_bytes) throw UserFacingError.localized("backup.error.invalidContents");
  return { userId: metadata.user_id, serverOrigin: metadata.server_origin, identity: metadata.identity, payloadBytes, createdAt: header.created_at, backupCheckpoint: metadata.backup_checkpoint };
}

export async function readPortableBackup(file: Blob, password: string, expectedOrigin?: string): Promise<PortableBackupContents> {
  const parts: BlobPart[] = [];
  const contents = await streamPortableBackupPayload(file, password, async (bytes) => { parts.push(ownedBuffer(bytes)); }, expectedOrigin);
  const { payloadBytes: _, ...metadata } = contents;
  return { ...metadata, historyBundle: new Blob(parts) };
}
