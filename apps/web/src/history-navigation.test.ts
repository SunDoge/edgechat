import { describe, expect, it } from "vitest";
import type { RoomId } from "@edgechat/protocol";
import { canApplyHistoryNavigation, shouldMarkIncomingRead } from "./history-navigation";

const room = "!history:example.com" as RoomId;

describe("local history navigation", () => {
  it("rejects a stale result after a newer navigation or room switch", () => {
    expect(canApplyHistoryNavigation(4, 5, room, room)).toBe(false);
    expect(canApplyHistoryNavigation(5, 5, room, "!other:example.com" as RoomId)).toBe(false);
    expect(canApplyHistoryNavigation(5, 5, room, room)).toBe(true);
  });

  it("does not mark newly arriving messages read while viewing old context", () => {
    expect(shouldMarkIncomingRead({ roomId: room }, room)).toBe(false);
    expect(shouldMarkIncomingRead(null, room)).toBe(true);
  });
});
