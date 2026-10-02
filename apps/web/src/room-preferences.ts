import type { LocalRoomPreference } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";

export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;
export type RoomPreferenceAction = "pin" | "mute" | "archive";

export function defaultRoomPreference(roomId: RoomId): LocalRoomPreference {
  return { room_id: roomId, pinned_at: null, archived_at: null, muted_until: null, local_retention_days: null, updated_at: 0 };
}

export function applyRoomPreferenceAction(current: LocalRoomPreference, action: RoomPreferenceAction, now: number): LocalRoomPreference {
  const next = { ...current, updated_at: now };
  if (action === "pin") next.pinned_at = current.pinned_at === null ? now : null;
  if (action === "archive") {
    next.archived_at = current.archived_at === null ? now : null;
    if (next.archived_at !== null) next.pinned_at = null;
  }
  if (action === "mute") {
    const muted = current.muted_until !== null && Number(current.muted_until) > now;
    next.muted_until = muted ? null : MUTE_FOREVER;
  }
  return next;
}

export function organizedRooms<T extends { room_id: RoomId }>(rooms: T[], preferences: Record<string, LocalRoomPreference>, archived: boolean): T[] {
  const originalOrder = new Map(rooms.map((room, index) => [room.room_id, index]));
  const preference = (roomId: RoomId) => preferences[roomId] ?? defaultRoomPreference(roomId);
  return rooms.filter((room) => (preference(room.room_id).archived_at !== null) === archived).sort((left, right) => {
    const pinned = Number(preference(right.room_id).pinned_at ?? 0) - Number(preference(left.room_id).pinned_at ?? 0);
    return pinned || (originalOrder.get(left.room_id) ?? 0) - (originalOrder.get(right.room_id) ?? 0);
  });
}
