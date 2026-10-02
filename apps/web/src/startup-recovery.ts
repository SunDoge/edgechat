export type StartupFailureKind = "newer-client-required" | "local-database" | "device-crypto" | "service-unavailable" | "unknown";

export type StartupFailure = Readonly<{
  kind: StartupFailureKind;
  code: string;
  title: string;
  summary: string;
  primaryAction: string;
  primaryIntent: "retry" | "restore";
}>;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
}

export function describeStartupFailure(cause: unknown): StartupFailure {
  const message = errorMessage(cause);
  if (/Local database schema \d+ is newer than this client supports/i.test(message)) {
    return {
      kind: "newer-client-required",
      code: "LOCAL_SCHEMA_NEWER",
      title: "需要更新 EdgeChat",
      summary: "这份本机记录由更新版本的应用写入。当前版本没有尝试降级或修改它，请更新后重新打开。",
      primaryAction: "检查更新并重试",
      primaryIntent: "retry",
    };
  }
  if (/Local (?:database|schema) migration|PGlite|OPFS|IndexedDB|database schema version/i.test(message)) {
    return {
      kind: "local-database",
      code: "LOCAL_DATABASE_UNAVAILABLE",
      title: "本机消息库未能安全打开",
      summary: "你的本机记录没有被自动删除。EdgeChat 已停止继续写入，以免让问题扩大。",
      primaryAction: "重新尝试打开",
      primaryIntent: "retry",
    };
  }
  if (/MLS|cryptographic|crypto state|device (?:identity|key)|加密状态|设备密钥/i.test(message)) {
    return {
      kind: "device-crypto",
      code: "DEVICE_CRYPTO_UNAVAILABLE",
      title: "设备加密状态未能载入",
      summary: "消息库仍保留在这台设备上，但在安全恢复设备密钥前不能继续收发或解密消息。",
      primaryAction: "重新尝试打开",
      primaryIntent: "retry",
    };
  }
  const status = cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number" ? cause.status : null;
  if (cause instanceof TypeError || status === 408 || status === 425 || status === 429 || (status !== null && status >= 500)) {
    return {
      kind: "service-unavailable",
      code: "STARTUP_SERVICE_UNAVAILABLE",
      title: "暂时无法完成启动",
      summary: "服务器或网络暂时不可用，并且这台设备还没有足够的离线启动信息。本机记录没有被删除。",
      primaryAction: "重新连接并重试",
      primaryIntent: "retry",
    };
  }
  return {
    kind: "unknown",
    code: "STARTUP_UNEXPECTED_FAILURE",
    title: "暂时无法打开这个本机身份",
    summary: "EdgeChat 已停止启动并保留现有本机数据。重试无效时，可切换身份或使用已验证的加密备份恢复。",
    primaryAction: "重新尝试打开",
    primaryIntent: "retry",
  };
}

export const INTERRUPTED_RESTORE_FAILURE: StartupFailure = Object.freeze({
  kind: "local-database",
  code: "LOCAL_RESTORE_INTERRUPTED",
  title: "本机恢复尚未完成",
  summary: "上次恢复在安全切换完成前中断。请重新选择原备份继续验证；EdgeChat 不会尝试混用新旧消息库与设备密钥。",
  primaryAction: "重新选择备份",
  primaryIntent: "restore",
});
