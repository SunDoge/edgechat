import { assertCompatibleServerProtocol, isNamespacedRoomId, isNamespacedUserId } from "@edgechat/protocol";
import type { ServerRoom, SessionIdentity } from "@edgechat/sync";

export function offlineSessionSnapshot(session: SessionIdentity): SessionIdentity {
  return {
    user_id: session.user_id,
    device_id: session.device_id,
    display_name: session.display_name,
    avatar_url: session.avatar_url ?? null,
    archive_compaction_enabled: session.archive_compaction_enabled,
    protocol: assertCompatibleServerProtocol(session.protocol),
    ...(session.server_name ? { server_name: session.server_name } : {}),
    ...(session.vapid_public_key ? { vapid_public_key: session.vapid_public_key } : {}),
  };
}

export function cachedSessionForDevice(value: unknown, deviceId: string): SessionIdentity | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<SessionIdentity>;
  if (typeof session.user_id !== "string" || !isNamespacedUserId(session.user_id)
    || session.device_id !== deviceId
    || typeof session.display_name !== "string" || !session.display_name
    || (session.avatar_url !== undefined && session.avatar_url !== null && typeof session.avatar_url !== "string")
    || typeof session.archive_compaction_enabled !== "boolean"
    || (session.server_name !== undefined && typeof session.server_name !== "string")
    || (session.vapid_public_key !== undefined && typeof session.vapid_public_key !== "string")
    || (session.device_credential !== undefined && typeof session.device_credential !== "string")) return null;
  try { return { ...session, protocol: assertCompatibleServerProtocol(session.protocol) } as SessionIdentity; }
  catch { return null; }
}

export function validCachedRooms(values: unknown[]): ServerRoom[] {
  return values.filter((value): value is ServerRoom => {
    if (!value || typeof value !== "object") return false;
    const room = value as Partial<ServerRoom>;
    return typeof room.room_id === "string" && isNamespacedRoomId(room.room_id)
      && (room.kind === "direct" || room.kind === "group")
      && (room.purpose === "chat" || room.purpose === "saved")
      && (room.name === null || typeof room.name === "string")
      && Number.isSafeInteger(room.current_seq) && Number(room.current_seq) >= 0
      && Number.isSafeInteger(room.joined_seq) && Number(room.joined_seq) >= 0 && Number(room.joined_seq) <= Number(room.current_seq)
      && Number.isFinite(room.created_at) && Number(room.created_at) >= 0
      && typeof room.home_server === "string" && room.home_server.length > 0
      && (room.encrypted_state === null || typeof room.encrypted_state === "string")
      && (room.epoch === null || (Number.isSafeInteger(room.epoch) && Number(room.epoch) >= 0))
      && (room.muted_until === null || Number.isFinite(room.muted_until))
      && typeof room.blocked_by_me === "boolean"
      && Array.isArray(room.hidden_member_ids) && room.hidden_member_ids.every((userId) => typeof userId === "string" && isNamespacedUserId(userId))
      && Array.isArray(room.members) && room.members.every((member) => Boolean(member)
        && typeof member.user_id === "string" && isNamespacedUserId(member.user_id)
        && typeof member.display_name === "string" && member.display_name.length > 0 && member.display_name.length <= 60
        && (member.avatar_url === null || typeof member.avatar_url === "string")
        && (member.role === "owner" || member.role === "member"));
  });
}

export function canUseOfflineSession(error: unknown, browserOnline: boolean): boolean {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return !browserOnline || error instanceof TypeError;
}
