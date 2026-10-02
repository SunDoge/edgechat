import { ApiError } from "@edgechat/sync";

export function authErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case "invalid_credentials": return "用户名或密码不正确";
      case "authentication_rate_limited":
      case "unauthenticated_rate_limited":
      case "account_rate_limited": return "尝试次数过多，请一分钟后再试";
      case "already_exists": return "这个用户名或设备已存在";
      case "weak_password": return "密码至少需要 10 个字符";
      case "invalid_user_id": return "用户名格式不正确";
      case "client_upgrade_required": return "这个服务器需要更新版本的客户端";
      case "server_upgrade_required": return "服务器版本过旧，请联系管理员升级";
    }
    if (cause.status >= 500) return "服务器暂时不可用，请稍后再试";
  }
  return cause instanceof Error && cause.message ? cause.message : "无法连接服务器";
}
