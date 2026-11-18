import { isNamespacedRoomId, type RoomId } from "@edgechat/protocol";

export type NotificationTarget = { roomId: RoomId; seq: number };

export function parseNotificationTarget(hash: string): NotificationTarget | null {
  if (!hash.startsWith("#message?") || hash.length > 1024) return null;
  const query = new URLSearchParams(hash.slice("#message?".length));
  const roomId = query.get("room") ?? "";
  const value = query.get("seq") ?? "";
  const seq = Number(value);
  if (roomId.length > 255 || !isNamespacedRoomId(roomId) || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(seq)) return null;
  return { roomId, seq };
}
