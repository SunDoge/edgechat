import { ApiError, ApiTimeoutError } from "@edgechat/sync";
import { translate, type Translator } from "./i18n";
import { UserFacingError } from "./user-facing-error";

export { UserFacingError } from "./user-facing-error";

/**
 * Converts transport/API failures to actionable copy without exposing raw
 * server, storage-provider, or cryptographic diagnostics in the main UI.
 */
export function operationErrorMessage(cause: unknown, fallback: string, t: Translator = translate): string {
  if (cause instanceof UserFacingError) return cause.message;
  if (cause instanceof ApiError) {
    if (cause.code === "storage_quota_exceeded") return t("operation.error.storageQuota");
    if (cause.code === "client_upgrade_required") return t("operation.error.clientUpgrade");
    if (cause.code === "server_upgrade_required") return t("operation.error.serverUpgrade");
    if (cause.status === 429 || cause.code.endsWith("_rate_limited")) return t("operation.error.rateLimited");
    if (cause.status >= 500 || cause.status === 408 || cause.status === 425) return t("operation.error.server");
  }
  if (cause instanceof ApiTimeoutError || cause instanceof TypeError) return t("operation.error.connection");
  return fallback;
}
