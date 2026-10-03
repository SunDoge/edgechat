import type { MessageKey } from "./i18n";

export type StartupFailureKind = "newer-client-required" | "local-database" | "device-crypto" | "service-unavailable" | "unknown";

export type StartupRecoveryMessageKey = Extract<MessageKey, `startupRecovery.${string}`>;

export type StartupFailure = Readonly<{
  kind: StartupFailureKind;
  code: string;
  titleKey: StartupRecoveryMessageKey;
  summaryKey: StartupRecoveryMessageKey;
  primaryActionKey: StartupRecoveryMessageKey;
  primaryIntent: "retry" | "restore";
}>;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
}

export function describeStartupFailure(cause: unknown): StartupFailure {
  const message = errorMessage(cause);
  if (/Local database startup timed out/i.test(message)) {
    return {
      kind: "local-database",
      code: "LOCAL_DATABASE_STARTUP_TIMEOUT",
      titleKey: "startupRecovery.timeout.title",
      summaryKey: "startupRecovery.timeout.summary",
      primaryActionKey: "startupRecovery.action.reopen",
      primaryIntent: "retry",
    };
  }
  if (/Local database schema \d+ is newer than this client supports/i.test(message)) {
    return {
      kind: "newer-client-required",
      code: "LOCAL_SCHEMA_NEWER",
      titleKey: "startupRecovery.schema.title",
      summaryKey: "startupRecovery.schema.summary",
      primaryActionKey: "startupRecovery.action.update",
      primaryIntent: "retry",
    };
  }
  if (/Local (?:database|schema) migration|PGlite|OPFS|IndexedDB|database schema version/i.test(message)) {
    return {
      kind: "local-database",
      code: "LOCAL_DATABASE_UNAVAILABLE",
      titleKey: "startupRecovery.database.title",
      summaryKey: "startupRecovery.database.summary",
      primaryActionKey: "startupRecovery.action.retry",
      primaryIntent: "retry",
    };
  }
  if (/MLS|cryptographic|crypto state|device (?:identity|key)|加密状态|设备密钥/i.test(message)) {
    return {
      kind: "device-crypto",
      code: "DEVICE_CRYPTO_UNAVAILABLE",
      titleKey: "startupRecovery.crypto.title",
      summaryKey: "startupRecovery.crypto.summary",
      primaryActionKey: "startupRecovery.action.retry",
      primaryIntent: "retry",
    };
  }
  const status = cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number" ? cause.status : null;
  if (cause instanceof TypeError || status === 408 || status === 425 || status === 429 || (status !== null && status >= 500)) {
    return {
      kind: "service-unavailable",
      code: "STARTUP_SERVICE_UNAVAILABLE",
      titleKey: "startupRecovery.service.title",
      summaryKey: "startupRecovery.service.summary",
      primaryActionKey: "startupRecovery.action.reconnect",
      primaryIntent: "retry",
    };
  }
  return {
    kind: "unknown",
    code: "STARTUP_UNEXPECTED_FAILURE",
    titleKey: "startupRecovery.unknown.title",
    summaryKey: "startupRecovery.unknown.summary",
    primaryActionKey: "startupRecovery.action.retry",
    primaryIntent: "retry",
  };
}

export const INTERRUPTED_RESTORE_FAILURE: StartupFailure = Object.freeze({
  kind: "local-database",
  code: "LOCAL_RESTORE_INTERRUPTED",
  titleKey: "startupRecovery.interrupted.title",
  summaryKey: "startupRecovery.interrupted.summary",
  primaryActionKey: "startupRecovery.action.selectBackup",
  primaryIntent: "restore",
});
