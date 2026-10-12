import * as v from "valibot";

const encoder = new TextEncoder();
const MAGIC = encoder.encode("ECATT002");
export const ATTACHMENT_PREFIX_BYTES = 40;
export const ATTACHMENT_DEFAULT_CHUNK_BYTES = 256 * 1024;
export const ATTACHMENT_SINGLE_CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHUNKS = 4096;

const base64UrlSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));
const chunkSchema = v.strictObject({
  index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_CHUNKS - 1)),
  offset: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  ciphertext_length: v.pipe(v.number(), v.integer(), v.minValue(17), v.maxValue(1024 * 1024 + 16)),
  plaintext_length: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1024 * 1024)),
  nonce: base64UrlSchema,
});

export const encryptedAttachmentManifestSchema = v.strictObject({
  format: v.literal("edgechat-attachment"),
  version: v.literal(2),
  context: base64UrlSchema,
  algorithm: v.literal("AES-256-GCM"),
  kdf: v.literal("HKDF-SHA-256"),
  chunk_size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1024 * 1024)),
  plaintext_size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  chunks: v.pipe(v.array(chunkSchema), v.minLength(1), v.maxLength(MAX_CHUNKS)),
});

export type EncryptedAttachmentManifest = v.InferOutput<typeof encryptedAttachmentManifestSchema>;
export type AttachmentCiphertextSource = (offset: number, length: number) => Promise<ArrayBuffer | Uint8Array<ArrayBufferLike>>;
export type EncryptedAttachmentV2 = {
  key: string;
  /** Manifest nonce, duplicated in signed message metadata to reject container substitution early. */
  nonce: string;
  ciphertext: ArrayBuffer;
  chunkSize: number;
  chunkCount: number;
};

export function parseEncryptedAttachmentManifest(value: unknown): EncryptedAttachmentManifest {
  const parsed = v.safeParse(encryptedAttachmentManifestSchema, value);
  if (!parsed.success) throw new Error("Invalid encrypted attachment manifest JSON");
  return parsed.output;
}

function base64Url(value: Uint8Array<ArrayBufferLike>): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string, expectedLength: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("Invalid attachment key material");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  } catch { throw new Error("Invalid attachment key material"); }
  if (bytes.length !== expectedLength) throw new Error("Invalid attachment key material");
  return bytes;
}

function concat(parts: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function equal(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function manifestAad(context: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`edgechat/attachment/v2/manifest|${context}`) as Uint8Array<ArrayBuffer>;
}

function chunkAad(context: string, index: number, plaintextLength: number, plaintextSize: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(`edgechat/attachment/v2/chunk|${context}|${index}|${plaintextLength}|${plaintextSize}`) as Uint8Array<ArrayBuffer>;
}

async function derivedKey(master: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) }, material,
    { name: "AES-GCM", length: 256 }, false, usages);
}

function validateAttachmentId(attachmentId: string): void {
  if (!/^[A-Za-z0-9_-]{32}$/.test(attachmentId)) throw new Error("Invalid attachment ID");
}

function validateManifest(manifest: EncryptedAttachmentManifest, context: string): void {
  if (manifest.context !== context || manifest.chunks.length !== Math.ceil(manifest.plaintext_size / manifest.chunk_size)) {
    throw new Error("Invalid encrypted attachment manifest");
  }
  let offset = 0; let plaintextBytes = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    const expectedPlaintext = Math.min(manifest.chunk_size, manifest.plaintext_size - plaintextBytes);
    if (chunk.index !== index || chunk.offset !== offset || chunk.plaintext_length !== expectedPlaintext
      || chunk.ciphertext_length !== chunk.plaintext_length + 16) throw new Error("Invalid encrypted attachment manifest");
    fromBase64Url(chunk.nonce, 12);
    offset += chunk.ciphertext_length; plaintextBytes += chunk.plaintext_length;
  }
  if (plaintextBytes !== manifest.plaintext_size || (manifest.chunks.length > 1 && manifest.chunk_size < 64 * 1024)) {
    throw new Error("Invalid encrypted attachment manifest");
  }
}

export async function encryptAttachmentV2(plaintext: ArrayBuffer, attachmentId: string): Promise<EncryptedAttachmentV2> {
  validateAttachmentId(attachmentId);
  const bytes = new Uint8Array(plaintext);
  if (!bytes.byteLength) throw new Error("Attachment plaintext must not be empty");
  const chunkSize = bytes.byteLength <= ATTACHMENT_SINGLE_CHUNK_BYTES ? bytes.byteLength : ATTACHMENT_DEFAULT_CHUNK_BYTES;
  const chunkCount = Math.ceil(bytes.byteLength / chunkSize);
  if (chunkCount > MAX_CHUNKS) throw new Error("Attachment has too many chunks");
  const master = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const manifestNonce = crypto.getRandomValues(new Uint8Array(12));
  const context = base64Url(manifestNonce);
  const encryptedChunks: Uint8Array<ArrayBuffer>[] = [];
  const chunks: EncryptedAttachmentManifest["chunks"] = [];
  let ciphertextOffset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize; const chunkPlaintext = bytes.slice(start, Math.min(bytes.length, start + chunkSize));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await derivedKey(master, salt, `edgechat/attachment/v2/chunk-key|${context}|${index}`, ["encrypt"]);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: chunkAad(context, index, chunkPlaintext.length, bytes.length) }, key, chunkPlaintext));
    encryptedChunks.push(sealed);
    chunks.push({ index, offset: ciphertextOffset, ciphertext_length: sealed.length, plaintext_length: chunkPlaintext.length, nonce: base64Url(nonce) });
    ciphertextOffset += sealed.length;
  }
  const manifest: EncryptedAttachmentManifest = {
    format: "edgechat-attachment", version: 2, context, algorithm: "AES-256-GCM", kdf: "HKDF-SHA-256",
    chunk_size: chunkSize, plaintext_size: bytes.length, chunks,
  };
  const manifestPlaintext = encoder.encode(JSON.stringify(manifest));
  if (manifestPlaintext.length > MAX_MANIFEST_BYTES - 16) throw new Error("Encrypted attachment manifest is too large");
  const manifestKey = await derivedKey(master, salt, `edgechat/attachment/v2/manifest-key|${context}`, ["encrypt"]);
  const sealedManifest = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: manifestNonce,
    additionalData: manifestAad(context) }, manifestKey, manifestPlaintext));
  const prefix = new Uint8Array(ATTACHMENT_PREFIX_BYTES);
  prefix.set(MAGIC, 0); prefix.set(salt, 8); prefix.set(manifestNonce, 24);
  new DataView(prefix.buffer).setUint32(36, sealedManifest.length, false);
  const ciphertext = concat([prefix, sealedManifest, ...encryptedChunks]);
  return { key: base64Url(master), nonce: context, ciphertext: ciphertext.buffer, chunkSize, chunkCount };
}

async function exactRead(source: AttachmentCiphertextSource, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new Error("Invalid attachment byte range");
  const value = await source(offset, length);
  const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
  if (bytes.byteLength !== length) throw new Error("Encrypted attachment range is truncated");
  return bytes;
}

export async function readEncryptedAttachmentManifest(source: AttachmentCiphertextSource, keyBytes: string, expectedNonce: string,
  attachmentId: string): Promise<{ manifest: EncryptedAttachmentManifest; dataOffset: number; salt: Uint8Array<ArrayBuffer> }> {
  validateAttachmentId(attachmentId);
  const master = fromBase64Url(keyBytes, 32); const metadataNonce = fromBase64Url(expectedNonce, 12);
  const prefix = await exactRead(source, 0, ATTACHMENT_PREFIX_BYTES);
  if (!equal(prefix.slice(0, 8), MAGIC)) throw new Error("Unsupported encrypted attachment format");
  const salt = prefix.slice(8, 24); const nonce = prefix.slice(24, 36);
  if (!equal(nonce, metadataNonce)) throw new Error("Encrypted attachment nonce does not match message metadata");
  const manifestLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(36, false);
  if (manifestLength < 17 || manifestLength > MAX_MANIFEST_BYTES) throw new Error("Invalid encrypted attachment manifest length");
  const sealedManifest = await exactRead(source, ATTACHMENT_PREFIX_BYTES, manifestLength);
  try {
    const manifestKey = await derivedKey(master, salt, `edgechat/attachment/v2/manifest-key|${expectedNonce}`, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: manifestAad(expectedNonce) }, manifestKey, sealedManifest);
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const manifest = parseEncryptedAttachmentManifest(decoded);
    validateManifest(manifest, expectedNonce);
    return { manifest, dataOffset: ATTACHMENT_PREFIX_BYTES + manifestLength, salt };
  } catch { throw new Error("Encrypted attachment manifest authentication failed"); }
}

export async function decryptAttachmentRangeV2(source: AttachmentCiphertextSource, keyBytes: string, expectedNonce: string,
  attachmentId: string, plaintextOffset = 0, plaintextLength?: number): Promise<ArrayBuffer> {
  const { manifest, dataOffset, salt } = await readEncryptedAttachmentManifest(source, keyBytes, expectedNonce, attachmentId);
  const length = plaintextLength ?? manifest.plaintext_size - plaintextOffset;
  if (!Number.isSafeInteger(plaintextOffset) || plaintextOffset < 0 || !Number.isSafeInteger(length) || length < 1
    || plaintextOffset + length > manifest.plaintext_size) throw new Error("Invalid attachment plaintext range");
  const first = Math.floor(plaintextOffset / manifest.chunk_size);
  const last = Math.floor((plaintextOffset + length - 1) / manifest.chunk_size);
  const selected = manifest.chunks.slice(first, last + 1);
  const encryptedOffset = selected[0]!.offset;
  const encryptedLength = selected.reduce((total, chunk) => total + chunk.ciphertext_length, 0);
  const sealed = await exactRead(source, dataOffset + encryptedOffset, encryptedLength);
  const master = fromBase64Url(keyBytes, 32);
  const plaintextChunks: Uint8Array<ArrayBuffer>[] = [];
  let sealedOffset = 0;
  try {
    for (const chunk of selected) {
      const encryptedChunk = sealed.slice(sealedOffset, sealedOffset + chunk.ciphertext_length); sealedOffset += chunk.ciphertext_length;
      const chunkKey = await derivedKey(master, salt, `edgechat/attachment/v2/chunk-key|${expectedNonce}|${chunk.index}`, ["decrypt"]);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(chunk.nonce, 12),
        additionalData: chunkAad(expectedNonce, chunk.index, chunk.plaintext_length, manifest.plaintext_size) }, chunkKey, encryptedChunk));
      if (plaintext.length !== chunk.plaintext_length) throw new Error("length");
      plaintextChunks.push(plaintext);
    }
  } catch { throw new Error("Encrypted attachment chunk authentication failed"); }
  const expanded = concat(plaintextChunks);
  const relativeStart = plaintextOffset - first * manifest.chunk_size;
  return expanded.slice(relativeStart, relativeStart + length).buffer;
}

export async function decryptAttachmentV2(ciphertext: ArrayBuffer, keyBytes: string, expectedNonce: string,
  attachmentId: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(ciphertext);
  const source: AttachmentCiphertextSource = async (offset, length) => bytes.slice(offset, offset + length);
  const { manifest, dataOffset } = await readEncryptedAttachmentManifest(source, keyBytes, expectedNonce, attachmentId);
  const last = manifest.chunks.at(-1)!;
  if (dataOffset + last.offset + last.ciphertext_length !== bytes.length) throw new Error("Encrypted attachment length mismatch");
  return decryptAttachmentRangeV2(source, keyBytes, expectedNonce, attachmentId, 0, manifest.plaintext_size);
}
