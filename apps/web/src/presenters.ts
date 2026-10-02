import type { ServerRoom } from "@edgechat/sync";

export function initials(value: string) { return value.replace(/^[@!]/, "").slice(0, 2).toUpperCase(); }
export function userName(id: string) { return id.slice(1, id.lastIndexOf(":")); }
export function memberName(room: ServerRoom, userId: string) {
  return room.members.find((member) => member.user_id === userId)?.display_name || userName(userId);
}
export function roomTitle(room: ServerRoom, me: string) { return room.purpose === "saved" ? "已保存消息" : room.name || room.members.find((member) => member.user_id !== me)?.display_name || userName(room.room_id); }
export function avatarColor(id: string) { return ["#2563eb", "#0f766e", "#b45309", "#7c3aed", "#be185d"][Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5]; }
