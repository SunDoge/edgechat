import type { RoomId } from "@edgechat/protocol";

export type ActiveHistoryFocus = { roomId: RoomId } | null;

export function canApplyHistoryNavigation(expectedRevision: number, currentRevision: number, requestedRoomId: RoomId, selectedRoomId: RoomId | null): boolean {
  return expectedRevision === currentRevision && requestedRoomId === selectedRoomId;
}

export function shouldMarkIncomingRead(focus: ActiveHistoryFocus, roomId: RoomId, nearBottom = true): boolean {
  return nearBottom && focus?.roomId !== roomId;
}

export function countIncomingMessagesAfter(
  messages: readonly { seq: number; sender: string; deleted_at: number | null }[],
  currentUserId: string,
  afterSeq: number,
): number {
  return messages.filter((message) => Number(message.seq) > afterSeq && message.sender !== currentUserId && !message.deleted_at).length;
}
