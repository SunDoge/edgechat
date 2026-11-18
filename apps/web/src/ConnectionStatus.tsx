import type { RuntimeConnection } from "@edgechat/client-runtime";

const labels: Record<RuntimeConnection, string> = {
  starting: "正在连接服务器",
  online: "服务器连接正常",
  offline: "设备离线",
  unavailable: "服务器连接异常",
  "session-expired": "会话已失效",
  stopped: "连接已停止",
};

export function ConnectionStatus({ connection }: { connection: RuntimeConnection }) {
  const dot = connection === "online" ? "bg-emerald-600"
    : connection === "starting" ? "bg-amber-500" : "bg-red-500";
  return <p role="status" className="flex items-center gap-1.5 text-[11px] text-muted">
    <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
    {labels[connection]}
  </p>;
}
