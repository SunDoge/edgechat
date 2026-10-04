import type { StaticMessageKey } from "./i18n";
import { UserFacingError } from "./user-facing-error";

export type RoomOperationErrorCode =
  | "crypto_not_ready"
  | "membership_busy"
  | "owner_required"
  | "keys_changed"
  | "member_has_no_active_devices"
  | "owner_transfer_unsupported"
  | "owner_transfer_target_invalid"
  | "history_recovery_required"
  | "owner_transfer_pending"
  | "peer_recovery_unsupported";

const MESSAGE_KEYS = {
  crypto_not_ready: "workspace.roomOperation.error.notReady",
  membership_busy: "workspace.feedback.membershipBusy",
  owner_required: "workspace.roomOperation.error.ownerOnly",
  keys_changed: "workspace.roomOperation.error.keysChanged",
  member_has_no_active_devices: "workspace.roomOperation.error.memberNoDevices",
  owner_transfer_unsupported: "workspace.roomOperation.error.ownerTransferUnsupported",
  owner_transfer_target_invalid: "workspace.roomOperation.error.ownerTransferTarget",
  history_recovery_required: "workspace.feedback.groupRecovery",
  owner_transfer_pending: "workspace.roomOperation.error.ownerTransferPending",
  peer_recovery_unsupported: "workspace.historyRecovery.error.unsupported",
} as const satisfies Record<RoomOperationErrorCode, StaticMessageKey>;

/** Expected room state that the user can recover from without exposing MLS internals. */
export class RoomOperationError extends UserFacingError<StaticMessageKey> {
  constructor(readonly code: RoomOperationErrorCode) {
    super(MESSAGE_KEYS[code], {});
    this.name = "RoomOperationError";
  }
}
