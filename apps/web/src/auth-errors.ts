import { ApiError } from "@edgechat/sync";
import { translate, type Translator } from "./i18n";

export function authErrorMessage(cause: unknown, t: Translator = translate): string {
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
    }
    if (cause.status >= 500) return t("auth.error.serverUnavailable");
  }
  return cause instanceof Error && cause.message ? cause.message : t("auth.error.connection");
}
