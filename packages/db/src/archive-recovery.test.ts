import { describe, expect, it, vi } from "vitest";
import type { RoomId } from "@edgechat/protocol";
import { LocalDatabase } from "./index";

const roomId = "!0123456789abcdef:example.com" as RoomId;

describe("local archive recovery queue", () => {
  it("recovers both crash-left uploading jobs and explicitly ambiguous uploads with a bounded query", async () => {
    const query = vi.fn(async () => [
      { room_id: roomId, segment_id: "segment", lease_token: "lease", start_seq: "1", end_seq: "10", expires_at: "20" },
    ]);
    const db = { query } as unknown as LocalDatabase;

    await expect(LocalDatabase.prototype.pendingArchiveUploadResolutions.call(db, 500)).resolves.toEqual([
      { room_id: roomId, segment_id: "segment", lease_token: "lease", start_seq: 1, end_seq: 10, expires_at: 20 },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status IN ('uploading', 'upload_unknown')"), [100]);
  });

  it("blocks a new room compaction while upload resolution or retention acknowledgement is pending", async () => {
    const query = vi.fn(async () => [{ pending: 1 }]);
    const db = { query } as unknown as LocalDatabase;

    await expect(LocalDatabase.prototype.hasPendingArchiveRecovery.call(db, roomId)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status IN ('uploading', 'upload_unknown', 'uploaded')"), [roomId]);
  });
});
