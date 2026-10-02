import { describe, expect, it } from "vitest";
import type { RoomId } from "@edgechat/protocol";
import { canApplyHistoryNavigation, countIncomingMessagesAfter, shouldMarkIncomingRead } from "./history-navigation";

const room = "!history:example.com" as RoomId;

describe("local history navigation", () => {
  it("rejects a stale result after a newer navigation or room switch", () => {
    expect(canApplyHistoryNavigation(4, 5, room, room)).toBe(false);
    expect(canApplyHistoryNavigation(5, 5, room, "!other:example.com" as RoomId)).toBe(false);
    expect(canApplyHistoryNavigation(5, 5, room, room)).toBe(true);
  });

  it("does not mark newly arriving messages read while viewing old context", () => {
    expect(shouldMarkIncomingRead({ roomId: room }, room)).toBe(false);
    expect(shouldMarkIncomingRead(null, room, false)).toBe(false);
    expect(shouldMarkIncomingRead(null, room)).toBe(true);
  });

  it("counts only live incoming messages beyond the scroll-away boundary", () => {
    expect(countIncomingMessagesAfter([
      { seq: 4, sender: "@bob:example.com", deleted_at: null },
      { seq: 5, sender: "@alice:example.com", deleted_at: null },
      { seq: 6, sender: "@bob:example.com", deleted_at: 7 },
      { seq: 7, sender: "@bob:example.com", deleted_at: null },
    ], "@alice:example.com", 4)).toBe(1);
  });
});
