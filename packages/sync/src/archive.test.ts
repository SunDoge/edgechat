import { describe, expect, it } from "vitest";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import { buildSegment, decodeSegmentChunk, decodeSegmentHeader, decodeSegmentIndex, rangesForSequences, SEGMENT_HEADER_BYTES, validateSegmentIndex } from "./archive";

const roomId = "!0123456789abcdef:example.com" as RoomId;
const keyEnvelope = new Uint8Array(64).fill(7);
const events = Array.from({ length: 8 }, (_, index): RoomEvent => ({
  event_id: `$test-event-${index}:example.com`, room_id: roomId, seq: index + 1, sender: "@alice:example.com",
  device_id: "device", type: "message.text", created_at: index, ciphertext: `cipher-${index}`,
  metadata: {}, signature: "signature",
}));

describe("range-decodable archive segments", () => {
  it("decodes index and independent chunks", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const built = await buildSegment(roomId, "segment-1", events, key, keyEnvelope, 180);
    const header = decodeSegmentHeader(built.bytes.slice(0, SEGMENT_HEADER_BYTES));
    expect(header.compression).toBe("zstd");
    expect(built.bytes.slice(header.key_envelope_offset, header.index_offset)).toEqual(keyEnvelope);
    const index = await decodeSegmentIndex(roomId, "segment-1", built.bytes.slice(header.index_offset, header.index_offset + header.index_length), key, header.index_uncompressed_length);
    const descriptor = index.chunks[0];
    const dataOffset = header.index_offset + header.index_length;
    const decoded = await decodeSegmentChunk(roomId, "segment-1", 0, built.bytes.slice(dataOffset + descriptor.offset, dataOffset + descriptor.offset + descriptor.length), key, descriptor.uncompressed_length);
    expect(decoded[0].seq).toBe(1);
  });

  it("rejects authenticated chunk tampering", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const built = await buildSegment(roomId, "segment-2", events, key, keyEnvelope, 180);
    const header = decodeSegmentHeader(built.bytes.slice(0, SEGMENT_HEADER_BYTES));
    const descriptor = built.index.chunks[0];
    const offset = header.index_offset + header.index_length + descriptor.offset;
    const chunk = built.bytes.slice(offset, offset + descriptor.length);
    chunk[chunk.length - 1] ^= 1;
    await expect(decodeSegmentChunk(roomId, "segment-2", 0, chunk, key, descriptor.uncompressed_length)).rejects.toThrow();
  });

  it("maps a partial sequence selection to only the required ranges", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const built = await buildSegment(roomId, "segment-3", events, key, keyEnvelope, 180);
    const ranges = rangesForSequences(built.index, [events.at(-1)!.seq]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].chunk).toBe(built.index.entries[String(events.at(-1)!.seq)]);
  });

  it("rejects a forged decompressed size before allocating", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const built = await buildSegment(roomId, "segment-4", events, key, keyEnvelope, 180);
    const header = decodeSegmentHeader(built.bytes.slice(0, SEGMENT_HEADER_BYTES));
    const descriptor = built.index.chunks[0];
    const offset = header.index_offset + header.index_length + descriptor.offset;
    const chunk = built.bytes.slice(offset, offset + descriptor.length);
    await expect(decodeSegmentChunk(roomId, "segment-4", 0, chunk, key, 9 * 1024 * 1024)).rejects.toThrow("decompressed length");
  });

  it("rejects non-contiguous input before building an archive", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const broken = events.map((event) => ({ ...event }));
    broken[4].seq = 99;
    await expect(buildSegment(roomId, "segment-5", broken, key, keyEnvelope)).rejects.toThrow("contiguous sequence");
  });

  it("rejects a malformed signed-event envelope before archive upload", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const malformed = [{ ...events[0], event_id: "local-only" }] as unknown as RoomEvent[];
    await expect(buildSegment(roomId, "segment-invalid-envelope", malformed, key, keyEnvelope))
      .rejects.toThrow("invalid room event envelope");
  });

  it("cross-checks chunk layout, sequence mappings, and object size", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const built = await buildSegment(roomId, "segment-6", events, key, keyEnvelope, 180);
    const header = decodeSegmentHeader(built.bytes.slice(0, SEGMENT_HEADER_BYTES));
    expect(() => validateSegmentIndex(built.index, { header, object_bytes: built.bytes.length })).not.toThrow();

    const gap = structuredClone(built.index);
    delete gap.entries["4"];
    expect(() => validateSegmentIndex(gap, { header, object_bytes: built.bytes.length })).toThrow("entry count");

    const overlap = structuredClone(built.index);
    if (overlap.chunks.length < 2) throw new Error("test segment unexpectedly has one chunk");
    overlap.chunks[1].offset--;
    expect(() => validateSegmentIndex(overlap, { header, object_bytes: built.bytes.length })).toThrow("chunk descriptor");

    expect(() => validateSegmentIndex(built.index, { header, object_bytes: built.bytes.length + 1 })).toThrow("object length");
  });
});
