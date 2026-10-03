import { ApiError, ApiTimeoutError } from "@edgechat/sync";
import { translate, type Translator } from "./i18n";
import { UserFacingError } from "./operation-errors";

export function authErrorMessage(cause: unknown, t: Translator = translate, fallback = t("auth.error.localSecurity")): string {
  if (cause instanceof UserFacingError) return cause.messageKey ? t(cause.messageKey) : cause.message;
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case "invalid_credentials": return t("auth.error.invalidCredentials");
      case "authentication_rate_limited":
      case "unauthenticated_rate_limited":
      case "account_rate_limited": return t("auth.error.rateLimited");
      case "already_exists": return t("auth.error.alreadyExists");
      case "weak_password": return t("auth.error.weakPassword");
      case "invalid_user_id": return t("auth.error.invalidUserId");
      case "client_upgrade_required": return t("auth.error.clientUpgrade");
      case "server_upgrade_required": return t("auth.error.serverUpgrade");
      case "passkey_secure_origin_required": return t("auth.error.passkeySecureOrigin");
      case "invalid_passkey_response":
      case "invalid_passkey_challenge": return t("auth.error.passkeyInvalid");
      case "invalid_passkey_name": return t("auth.error.passkeyName");
      case "passkey_limit_reached": return t("auth.error.passkeyLimit");
      case "passkey_exists": return t("auth.error.passkeyExists");
      case "passkey_not_found": return t("auth.error.passkeyMissing");
      case "password_change_not_supported": return t("auth.error.passwordChangeUnsupported");
    }
    if (cause.status >= 500) return t("auth.error.serverUnavailable");
    if (cause.status === 429) return t("auth.error.rateLimited");
    return fallback;
  }
  if (cause instanceof ApiTimeoutError || cause instanceof TypeError) return t("auth.error.connection");
  return fallback;
}
