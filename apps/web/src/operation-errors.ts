import { ApiError, ApiTimeoutError } from "@edgechat/sync";
import { translate, type Translator } from "./i18n";
import { UserFacingError } from "./user-facing-error";

export { UserFacingError } from "./user-facing-error";

/**
 * Converts transport/API failures to actionable copy without exposing raw
 * server, storage-provider, or cryptographic diagnostics in the main UI.
 */
export function operationErrorMessage(cause: unknown, fallback: string, t: Translator = translate): string {
  if (cause instanceof UserFacingError) return cause.messageKey ? t(cause.messageKey) : cause.message;
  if (cause instanceof ApiError) {
    if (cause.code === "storage_quota_exceeded") return t("operation.error.storageQuota");
    if (cause.code === "client_upgrade_required") return t("operation.error.clientUpgrade");
    if (cause.code === "server_upgrade_required") return t("operation.error.serverUpgrade");
    if (cause.code === "backup_restore_requires_password") return t("backup.restore.error.credential");
    if (cause.code === "backup_device_missing" || cause.code === "backup_device_invalid") return t("backup.restore.error.deviceInvalid");
    if (cause.code === "backup_checkpoint_invalid") return t("backup.restore.error.checkpoint");
    if (cause.code === "backup_stale") return t("backup.restore.error.stale");
    if (cause.code === "device_link_expired") return t("deviceLink.error.expired");
    if (cause.code === "device_link_cancelled") return t("deviceLink.error.cancelled");
    if (cause.code === "device_link_not_ready" || cause.code === "device_history_not_ready") return t("deviceLink.error.notReady");
    if (cause.code === "history_transfer_reupload_required") return t("deviceLink.error.remoteShardMissing");
    if (cause.code === "device_link_not_pending" || cause.code === "device_link_claimed") return t("deviceLinkApproval.error.ended");
    if (cause.code === "room_membership_busy") return t("deviceLinkApproval.error.membershipBusy");
    if (cause.status === 429 || cause.code.endsWith("_rate_limited")) return t("operation.error.rateLimited");
    if (cause.status >= 500 || cause.status === 408 || cause.status === 425) return t("operation.error.server");
  }
  if (cause instanceof ApiTimeoutError || cause instanceof TypeError) return t("operation.error.connection");
  return fallback;
}
