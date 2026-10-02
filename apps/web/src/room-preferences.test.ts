import { describe, expect, it } from "vitest";
import type { LocalRoomPreference } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { MUTE_FOREVER, applyRoomMute, applyRoomPreferenceAction, defaultRoomPreference, organizedRooms } from "./room-preferences";

const a = "!aaaaaaaaaaaaaaaa:example.com" as RoomId;
const b = "!bbbbbbbbbbbbbbbb:example.com" as RoomId;
const c = "!cccccccccccccccc:example.com" as RoomId;

describe("room organization", () => {
  it("keeps actions reversible and removes a pin when archiving", () => {
    const initial = defaultRoomPreference(a);
    const pinned = applyRoomPreferenceAction(initial, "pin", 10);
    expect(pinned.pinned_at).toBe(10);
    const archived = applyRoomPreferenceAction(pinned, "archive", 20);
    expect(archived).toMatchObject({ pinned_at: null, archived_at: 20 });
    expect(applyRoomPreferenceAction(archived, "archive", 30).archived_at).toBeNull();
    expect(applyRoomMute(initial, MUTE_FOREVER, 40).muted_until).toBe(MUTE_FOREVER);
    expect(applyRoomMute({ ...initial, muted_until: MUTE_FOREVER }, null, 50).muted_until).toBeNull();
    expect(applyRoomMute(initial, 49, 50).muted_until).toBeNull();
  });

  it("filters archives and moves pinned chats ahead without disturbing server order", () => {
    const preferences: Record<string, LocalRoomPreference> = {
      [b]: { ...defaultRoomPreference(b), pinned_at: 20 },
      [c]: { ...defaultRoomPreference(c), archived_at: 30 },
    };
    const rooms = [a, b, c].map((room_id) => ({ room_id }));
    expect(organizedRooms(rooms, preferences, false).map((room) => room.room_id)).toEqual([b, a]);
    expect(organizedRooms(rooms, preferences, true).map((room) => room.room_id)).toEqual([c]);
  });

  it("sorts unpinned chats by device-local activity", () => {
    const rooms = [a, b, c].map((room_id) => ({ room_id }));
    const preferences = { [b]: { ...defaultRoomPreference(b), pinned_at: 20 } };
    expect(organizedRooms(rooms, preferences, false, { [a]: 10, [b]: 5, [c]: 30 }).map((room) => room.room_id)).toEqual([b, c, a]);
  });
});
