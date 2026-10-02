export type HistoryRecoveryViewState = {
  phase: "requesting" | "waiting" | "transferring" | "importing" | "failed";
  message?: string;
};

export function historyRecoveryCopy(state: HistoryRecoveryViewState): { title: string; detail: string } {
  if (state.phase === "requesting") return { title: "正在请求恢复", detail: "正在联系你账户中的其他设备。" };
  if (state.phase === "transferring") return { title: "另一台设备正在准备记录", detail: "记录会先加密，再临时传到这台设备。" };
  if (state.phase === "importing") return { title: "正在验证并恢复", detail: "完成前此对话暂时只读，请保持页面打开。" };
  if (state.phase === "failed") return { title: "恢复暂时中断", detail: state.message || "请检查网络后重试。" };
  return { title: "等待另一台设备", detail: "请在仍保有这段记录的设备上打开 EdgeChat；它会自动发送加密副本。" };
}
