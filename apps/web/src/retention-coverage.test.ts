import { describe, expect, it, vi } from "vitest";
import type { LocalDatabase } from "@edgechat/db";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import { localRetentionCoverage } from "./retention-coverage";

const roomId = "!retention-coverage:example.com" as RoomId;
const state = { room_id: roomId, current_seq: 750, retention_floor_seq: 0, retention_generation: 3 };
function events(start: number, end: number): RoomEvent[] {
  return Array.from({ length: end - start + 1 }, (_, index) => ({ seq: start + index })) as RoomEvent[];
}

describe("localRetentionCoverage", () => {
  it("checks the exact local ledger in bounded reads", async () => {
    const signedEventRange = vi.fn(async (_room: RoomId, start: number, end: number) => ({ events: events(start, end), complete: true, missing_seq: null }));
    const result = await localRetentionCoverage({ signedEventRange } as unknown as LocalDatabase, state);
    expect(result).toEqual({ room_id: roomId, generation: 3, from_seq: 1, through_seq: 750 });
    expect(signedEventRange.mock.calls.map((call) => call.slice(1))).toEqual([[1, 500], [501, 750]]);
  });

  it("never claims across a missing local envelope", async () => {
    const signedEventRange = vi.fn()
      .mockResolvedValueOnce({ events: events(1, 500), complete: true, missing_seq: null })
      .mockResolvedValueOnce({ events: events(501, 619), complete: false, missing_seq: 620 });
    expect(await localRetentionCoverage({ signedEventRange } as unknown as LocalDatabase, state))
      .toEqual({ room_id: roomId, generation: 3, from_seq: 1, through_seq: 619 });
  });

  it("returns no acknowledgement when the first required sequence is absent", async () => {
    const db = { signedEventRange: async () => ({ events: [], complete: false, missing_seq: 1 }) } as unknown as LocalDatabase;
    expect(await localRetentionCoverage(db, state)).toBeNull();
  });
});
