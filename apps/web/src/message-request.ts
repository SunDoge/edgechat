export type ReceiptRoomState = {
  request_status?: "pending" | "accepted" | "rejected" | null;
  blocked_by_me?: boolean;
  leave_status?: "pending" | null;
};

/** Receipts are encrypted room events, so they must obey message-request policy too. */
export function roomAllowsReceipts(room: ReceiptRoomState | null | undefined): boolean {
  return Boolean(room && room.request_status !== "pending" && room.request_status !== "rejected" && !room.blocked_by_me && room.leave_status !== "pending");
}
