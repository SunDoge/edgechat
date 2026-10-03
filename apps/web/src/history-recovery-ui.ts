import type { Translator } from "./i18n";

export type HistoryRecoveryViewState = {
  phase: "requesting" | "waiting" | "transferring" | "importing" | "failed";
  message?: string;
};

export function historyRecoveryCopy(state: HistoryRecoveryViewState, t: Translator): { title: string; detail: string } {
  if (state.phase === "requesting") return { title: t("workspace.historyRecovery.requesting.title"), detail: t("workspace.historyRecovery.requesting.detail") };
  if (state.phase === "transferring") return { title: t("workspace.historyRecovery.transferring.title"), detail: t("workspace.historyRecovery.transferring.detail") };
  if (state.phase === "importing") return { title: t("workspace.historyRecovery.importing.title"), detail: t("workspace.historyRecovery.importing.detail") };
  if (state.phase === "failed") return { title: t("workspace.historyRecovery.failed.title"), detail: state.message || t("workspace.historyRecovery.failed.detail") };
  return { title: t("workspace.historyRecovery.waiting.title"), detail: t("workspace.historyRecovery.waiting.detail") };
}
