import type { LocalRoomPreference } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";

export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;
export type RoomPreferenceAction = "pin" | "archive";

export function defaultRoomPreference(roomId: RoomId): LocalRoomPreference {
  return { room_id: roomId, pinned_at: null, archived_at: null, muted_until: null, local_retention_days: null, manually_unread: false, updated_at: 0 };
}

export function applyRoomPreferenceAction(current: LocalRoomPreference, action: RoomPreferenceAction, now: number): LocalRoomPreference {
  const next = { ...current, updated_at: now };
  if (action === "pin") next.pinned_at = current.pinned_at === null ? now : null;
  if (action === "archive") {
    next.archived_at = current.archived_at === null ? now : null;
    if (next.archived_at !== null) next.pinned_at = null;
  }
  return next;
}

export function applyRoomMute(current: LocalRoomPreference, mutedUntil: number | null, now: number): LocalRoomPreference {
  const normalized = mutedUntil !== null && Number.isSafeInteger(mutedUntil) && mutedUntil > now ? mutedUntil : null;
  return { ...current, muted_until: normalized, updated_at: now };
}

export function organizedRooms<T extends { room_id: RoomId }>(rooms: T[], preferences: Record<string, LocalRoomPreference>, archived: boolean, activityAt: Record<string, number> = {}): T[] {
  const originalOrder = new Map(rooms.map((room, index) => [room.room_id, index]));
  const preference = (roomId: RoomId) => preferences[roomId] ?? defaultRoomPreference(roomId);
  return rooms.filter((room) => (preference(room.room_id).archived_at !== null) === archived).sort((left, right) => {
    const leftPinned = preference(left.room_id).pinned_at; const rightPinned = preference(right.room_id).pinned_at;
    if (leftPinned !== null || rightPinned !== null) {
      if (leftPinned === null) return 1;
      if (rightPinned === null) return -1;
      const pinnedOrder = Number(rightPinned) - Number(leftPinned);
      if (pinnedOrder) return pinnedOrder;
    }
    const activityOrder = Number(activityAt[right.room_id] ?? 0) - Number(activityAt[left.room_id] ?? 0);
    return activityOrder || (originalOrder.get(left.room_id) ?? 0) - (originalOrder.get(right.room_id) ?? 0);
  });
}
