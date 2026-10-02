import type { RoomId } from "@edgechat/protocol";

export type ActiveHistoryFocus = { roomId: RoomId } | null;

export function canApplyHistoryNavigation(expectedRevision: number, currentRevision: number, requestedRoomId: RoomId, selectedRoomId: RoomId | null): boolean {
  return expectedRevision === currentRevision && requestedRoomId === selectedRoomId;
}

export function shouldMarkIncomingRead(focus: ActiveHistoryFocus, roomId: RoomId): boolean {
  return focus?.roomId !== roomId;
}
