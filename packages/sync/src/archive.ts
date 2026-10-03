import { isRoomEventEnvelope, type RoomEvent, type RoomId } from "@edgechat/protocol";
import { compress as zstdCompress, decompress as zstdDecompress, init as initZrip } from "@paddor/zrip";

const MAGIC = new Uint8Array([0x45, 0x43, 0x41, 0x52]); // ECAR
const VERSION = 3;
const COMPRESSION_ZSTD = 1;
const MAX_KEY_ENVELOPE_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_EVENTS = 100_000;
export const SEGMENT_HEADER_BYTES = 40;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let zripReady: Promise<void> | null = null;

type ChunkDescriptor = { offset: number; length: number; uncompressed_length: number; first_seq: number; last_seq: number };
export type SegmentIndex = { entries: Record<string, number>; chunks: ChunkDescriptor[] };
export type SegmentHeader = { version: number; compression: "zstd"; key_envelope_offset: number; key_envelope_length: number; index_offset: number; index_length: number; index_uncompressed_length: number; chunk_count: number; start_seq: number; end_seq: number };

async function deriveKey(segmentKey: Uint8Array<ArrayBuffer>, chunkIndex: number, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", segmentKey, "HKDF", false, ["deriveKey"]);
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, chunkIndex);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: index, info: encoder.encode("edgechat/archive-chunk/v2") },
    material, { name: "AES-GCM", length: 256 }, false, usage,
  );
}

async function ensureZrip(): Promise<void> {
  await (zripReady ??= initZrip());
}

async function compress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  await ensureZrip();
  return Uint8Array.from(zstdCompress(bytes, 1)) as Uint8Array<ArrayBuffer>;
}

async function decompress(bytes: Uint8Array<ArrayBuffer>, expectedLength: number, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > maximum) throw new Error("Invalid archive decompressed length");
  await ensureZrip();
  const output = Uint8Array.from(zstdDecompress(bytes, { maxDecompressedSize: expectedLength })) as Uint8Array<ArrayBuffer>;
  if (output.length !== expectedLength) throw new Error("Archive decompressed length mismatch");
  return output;
}

async function encryptRecord(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext));
  const record = new Uint8Array(16 + ciphertext.length);
  record.set(nonce, 0);
  new DataView(record.buffer).setUint32(12, ciphertext.length);
  record.set(ciphertext, 16);
  return record;
}

async function decryptRecord(key: CryptoKey, record: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (record.length < 32) throw new Error("Truncated archive record");
  const length = new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(12);
  if (length !== record.length - 16) throw new Error("Invalid archive record length");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.slice(0, 12), additionalData: aad }, key, record.slice(16)));
}

function aad(roomId: RoomId, segmentId: string, index: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${roomId}|${segmentId}|${index}`);
}

export async function buildSegment(
  roomId: RoomId,
  segmentId: string,
  events: RoomEvent[],
  segmentKey: Uint8Array<ArrayBuffer>,
  keyEnvelope: Uint8Array<ArrayBuffer>,
  targetChunkBytes = 128 * 1024,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; index: SegmentIndex }> {
  if (!events.length) throw new Error("Cannot build an empty segment");
  if (events.length > MAX_SEGMENT_EVENTS) throw new Error("Archive segment contains too many events");
  if (keyEnvelope.length < 64 || keyEnvelope.length > MAX_KEY_ENVELOPE_BYTES) throw new Error("Invalid archive key envelope length");
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!isRoomEventEnvelope(event)) throw new Error("Archive input contains an invalid room event envelope");
    if (event.room_id !== roomId || !Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > 0xffff_ffff || (index > 0 && event.seq !== events[index - 1].seq + 1)) {
      throw new Error("Archive events must be a contiguous sequence for one room");
    }
  }
  const groups: RoomEvent[][] = [];
  let current: RoomEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const size = encoder.encode(JSON.stringify(event)).length + 1;
    if (current.length && currentBytes + size > targetChunkBytes) { groups.push(current); current = []; currentBytes = 0; }
    current.push(event); currentBytes += size;
  }
  if (current.length) groups.push(current);

  const encryptedChunks: Uint8Array<ArrayBuffer>[] = [];
  const uncompressedLengths: number[] = [];
  for (let index = 0; index < groups.length; index++) {
    const plaintext = encoder.encode(groups[index].map((event) => JSON.stringify(event)).join("\n"));
    if (plaintext.length > MAX_CHUNK_BYTES) throw new Error("Archive chunk exceeds decompression limit");
    uncompressedLengths.push(plaintext.length);
    const key = await deriveKey(segmentKey, index, ["encrypt"]);
    encryptedChunks.push(await encryptRecord(key, await compress(plaintext), aad(roomId, segmentId, index)));
  }

  const index: SegmentIndex = { entries: {}, chunks: [] };
  let relativeChunkOffset = 0;
  for (let chunk = 0; chunk < groups.length; chunk++) {
    const group = groups[chunk];
    index.chunks.push({ offset: relativeChunkOffset, length: encryptedChunks[chunk].length, uncompressed_length: uncompressedLengths[chunk], first_seq: group[0].seq, last_seq: group.at(-1)!.seq });
    relativeChunkOffset += encryptedChunks[chunk].length;
    for (const event of group) index.entries[String(event.seq)] = chunk;
  }
  const indexKey = await deriveKey(segmentKey, 0xffff_ffff, ["encrypt"]);
  const indexPlaintext = encoder.encode(JSON.stringify(index));
  const indexUncompressedLength = indexPlaintext.length;
  if (indexUncompressedLength > MAX_INDEX_BYTES) throw new Error("Archive index exceeds decompression limit");
  const encryptedIndex = await encryptRecord(indexKey, await compress(indexPlaintext), aad(roomId, segmentId, 0xffff_ffff));

  const header = new Uint8Array(SEGMENT_HEADER_BYTES);
  header.set(MAGIC, 0); header[4] = VERSION; header[5] = COMPRESSION_ZSTD;
  const view = new DataView(header.buffer);
  view.setUint32(8, SEGMENT_HEADER_BYTES);
  view.setUint32(12, keyEnvelope.length);
  view.setUint32(16, SEGMENT_HEADER_BYTES + keyEnvelope.length);
  view.setUint32(20, encryptedIndex.length);
  view.setUint32(24, encryptedChunks.length);
  view.setUint32(28, events[0].seq);
  view.setUint32(32, events.at(-1)!.seq);
  view.setUint32(36, indexUncompressedLength);
  const total = SEGMENT_HEADER_BYTES + keyEnvelope.length + encryptedIndex.length + encryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set(header, 0); bytes.set(keyEnvelope, SEGMENT_HEADER_BYTES); bytes.set(encryptedIndex, SEGMENT_HEADER_BYTES + keyEnvelope.length);
  let offset = SEGMENT_HEADER_BYTES + keyEnvelope.length + encryptedIndex.length;
  for (const chunk of encryptedChunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, index };
}

export function decodeSegmentHeader(bytes: Uint8Array<ArrayBuffer>): SegmentHeader {
  if (bytes.length < SEGMENT_HEADER_BYTES || !MAGIC.every((byte, i) => bytes[i] === byte)) throw new Error("Invalid archive segment header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[4];
  if (version !== VERSION) throw new Error("Unsupported archive segment version");
  if (bytes[5] !== COMPRESSION_ZSTD) throw new Error("Unsupported archive compression codec");
  const header: SegmentHeader = { version, compression: "zstd", key_envelope_offset: view.getUint32(8), key_envelope_length: view.getUint32(12), index_offset: view.getUint32(16), index_length: view.getUint32(20), chunk_count: view.getUint32(24), start_seq: view.getUint32(28), end_seq: view.getUint32(32), index_uncompressed_length: view.getUint32(36) };
  if (header.key_envelope_offset !== SEGMENT_HEADER_BYTES || header.key_envelope_length < 64 || header.key_envelope_length > MAX_KEY_ENVELOPE_BYTES || header.index_offset !== SEGMENT_HEADER_BYTES + header.key_envelope_length || header.index_length < 32 || header.index_length > MAX_INDEX_BYTES || header.chunk_count < 1 || header.chunk_count > MAX_SEGMENT_EVENTS || header.start_seq < 1 || header.end_seq < header.start_seq || header.end_seq - header.start_seq + 1 > MAX_SEGMENT_EVENTS || header.index_uncompressed_length < 2 || header.index_uncompressed_length > MAX_INDEX_BYTES) throw new Error("Invalid archive segment header");
  return header;
}

export type SegmentIndexExpectation = { header: SegmentHeader; object_bytes?: number };

export function validateSegmentIndex(index: SegmentIndex, expectation?: SegmentIndexExpectation): void {
  if (!index || !Array.isArray(index.chunks) || !index.entries || typeof index.entries !== "object" || Array.isArray(index.entries)) throw new Error("Invalid archive segment index");
  if (index.chunks.length < 1 || index.chunks.length > MAX_SEGMENT_EVENTS) throw new Error("Invalid archive chunk count");
  const header = expectation?.header;
  if (header && index.chunks.length !== header.chunk_count) throw new Error("Archive chunk count mismatch");
  let nextOffset = 0;
  let nextSequence = header?.start_seq ?? index.chunks[0]?.first_seq;
  for (const chunk of index.chunks) {
    if (!chunk || !Number.isSafeInteger(chunk.offset) || chunk.offset !== nextOffset || !Number.isSafeInteger(chunk.length) || chunk.length < 32 || !Number.isSafeInteger(chunk.uncompressed_length) || chunk.uncompressed_length < 1 || chunk.uncompressed_length > MAX_CHUNK_BYTES || !Number.isSafeInteger(chunk.first_seq) || !Number.isSafeInteger(chunk.last_seq) || chunk.first_seq < 1 || chunk.last_seq < chunk.first_seq || chunk.first_seq !== nextSequence) throw new Error("Invalid archive chunk descriptor");
    nextOffset += chunk.length;
    if (!Number.isSafeInteger(nextOffset)) throw new Error("Invalid archive chunk extent");
    nextSequence = chunk.last_seq + 1;
  }
  if (header && index.chunks.at(-1)!.last_seq !== header.end_seq) throw new Error("Archive sequence range mismatch");
  if (expectation?.object_bytes !== undefined) {
    const objectBytes = expectation.object_bytes;
    const dataOffset = header!.index_offset + header!.index_length;
    if (!Number.isSafeInteger(objectBytes) || objectBytes < dataOffset || dataOffset + nextOffset !== objectBytes) throw new Error("Archive object length mismatch");
  }

  const entries = Object.entries(index.entries);
  const expectedEntries = (header?.end_seq ?? index.chunks.at(-1)!.last_seq) - (header?.start_seq ?? index.chunks[0].first_seq) + 1;
  if (expectedEntries < 1 || expectedEntries > MAX_SEGMENT_EVENTS || entries.length !== expectedEntries) throw new Error("Archive index entry count mismatch");
  const seen = new Set<number>();
  for (const [rawSequence, chunkIndex] of entries) {
    const sequence = Number(rawSequence);
    if (!Number.isSafeInteger(sequence) || String(sequence) !== rawSequence || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= index.chunks.length || sequence < index.chunks[chunkIndex].first_seq || sequence > index.chunks[chunkIndex].last_seq || seen.has(sequence)) throw new Error("Invalid archive sequence mapping");
    seen.add(sequence);
  }
  const firstSequence = header?.start_seq ?? index.chunks[0].first_seq;
  for (let sequence = firstSequence; sequence < firstSequence + expectedEntries; sequence++) {
    if (!seen.has(sequence)) throw new Error("Archive index sequence gap");
  }
}

export async function decodeSegmentIndex(roomId: RoomId, segmentId: string, encrypted: Uint8Array<ArrayBuffer>, segmentKey: Uint8Array<ArrayBuffer>, uncompressedLength: number, expectation?: SegmentIndexExpectation): Promise<SegmentIndex> {
  const key = await deriveKey(segmentKey, 0xffff_ffff, ["decrypt"]);
  const parsed = JSON.parse(decoder.decode(await decompress(await decryptRecord(key, encrypted, aad(roomId, segmentId, 0xffff_ffff)), uncompressedLength, MAX_INDEX_BYTES))) as SegmentIndex;
  validateSegmentIndex(parsed, expectation);
  return parsed;
}

export async function decodeSegmentChunk(roomId: RoomId, segmentId: string, chunkIndex: number, encrypted: Uint8Array<ArrayBuffer>, segmentKey: Uint8Array<ArrayBuffer>, uncompressedLength: number): Promise<RoomEvent[]> {
  const key = await deriveKey(segmentKey, chunkIndex, ["decrypt"]);
  const plaintext = decoder.decode(await decompress(await decryptRecord(key, encrypted, aad(roomId, segmentId, chunkIndex)), uncompressedLength, MAX_CHUNK_BYTES));
  const events = plaintext.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  if (!events.every(isRoomEventEnvelope)) throw new Error("Archive chunk contains an invalid room event envelope");
  return events;
}

export function rangesForSequences(index: SegmentIndex, sequences: number[], dataOffset = 0): Array<{ chunk: number; offset: number; length: number }> {
  const chunks = Array.from(new Set(sequences.map((seq) => index.entries[String(seq)]).filter((value): value is number => value !== undefined)));
  return chunks.sort((a, b) => a - b).map((chunk) => ({ chunk, offset: dataOffset + index.chunks[chunk].offset, length: index.chunks[chunk].length }));
}
