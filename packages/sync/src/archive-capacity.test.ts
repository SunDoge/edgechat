import { describe, expect, it } from "vitest";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import { createCapacityPlan, DEFAULT_SCENARIO } from "../../capacity-plan/src/model.mjs";
import { buildSegment } from "./archive";

const roomId = "!capacity-calibration:example.com" as RoomId;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();

function deterministicCiphertext(length: number, seed: number): string {
  let state = seed || 1;
  let output = "";
  for (let index = 0; index < length; index++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    output += alphabet[(state >>> 0) & 63];
  }
  return output;
}

function encryptedEvents(ciphertextLength: number): RoomEvent[] {
  return Array.from({ length: 500 }, (_, index) => {
    const seq = index + 1;
    return {
      event_id: `$capacity-${seq}:example.com`, room_id: roomId, seq,
      sender: "@alice:example.com", device_id: "device-capacity",
      type: "message.text", created_at: 1_800_000_000_000 + seq,
      ciphertext: deterministicCiphertext(ciphertextLength, seq * 0x9e3779b1),
      metadata: { mls_epoch: seq, content_encoding: "base64url" },
      signature: deterministicCiphertext(86, seq * 17),
      acceptance_receipt: {
        version: 1, key_id: "v1", room_id: roomId, seq,
        event_id: `$capacity-${seq}:example.com`,
        event_hash: deterministicCiphertext(43, seq * 31),
        retention_generation: 1, accepted_at: 1_800_000_001_000 + seq,
        mac: deterministicCiphertext(43, seq * 47),
      },
    } satisfies RoomEvent;
  });
}

describe("capacity planning calibration", () => {
  for (const ciphertextLength of [512, 8_192]) {
    it(`does not undercount a real zstd segment with ${ciphertextLength}-character MLS ciphertext`, async () => {
      const events = encryptedEvents(ciphertextLength);
      const sourceBytes = events.reduce((total, event) => total + encoder.encode(JSON.stringify(event)).length, 0);
      const averageEventBytes = Math.ceil(sourceBytes / events.length);
      const envelope = crypto.getRandomValues(new Uint8Array(DEFAULT_SCENARIO.keyEnvelopeBytes));
      const built = await buildSegment(roomId, `capacity-${ciphertextLength}`, events, crypto.getRandomValues(new Uint8Array(32)), envelope);
      const forecast = createCapacityPlan({
        days: 1, rooms: 1, eventsPerRoomPerDay: 532, averageEventBytes,
        attachmentRate: 0, coldArchiveLookupsPerDay: 0,
        warmArchiveLookupsPerDay: 0, attachmentDownloadsPerDay: 0,
      });

      expect(forecast.archive.segments).toBe(1);
      expect(forecast.archive.estimated_object_bytes).toBeGreaterThanOrEqual(built.bytes.length);
      // Small events have a large repeated JSON fraction and can compress much
      // better than ciphertext-heavy events. Keep the planner conservative,
      // but catch a unit/framing error that inflates it beyond roughly 2x.
      expect(forecast.archive.estimated_object_bytes).toBeLessThanOrEqual(Math.ceil(built.bytes.length * 2.1));
    });
  }
});
