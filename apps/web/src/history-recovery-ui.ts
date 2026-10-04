import { ApiError } from "@edgechat/sync";
import type { StaticMessageKey, Translator } from "./i18n";
import { RoomPeerRecoveryError } from "./room-peer-recovery";

export type HistoryRecoveryViewState = {
  phase: "requesting" | "waiting" | "transferring" | "importing" | "failed";
  errorKey?: StaticMessageKey;
};

export function historyRecoveryErrorKey(cause: unknown, online: boolean): StaticMessageKey {
  if (!online) return "workspace.historyRecovery.error.offline";
  if (cause instanceof RoomPeerRecoveryError) return cause.messageKey ?? "workspace.historyRecovery.error.invalid";
  if (cause instanceof ApiError && cause.code === "peer_recovery_source_unavailable") return "workspace.historyRecovery.error.noSource";
  if (cause instanceof ApiError && (cause.status === 409 || cause.status === 429)) return "workspace.historyRecovery.error.busy";
  if (cause instanceof ApiError && cause.status >= 500) return "workspace.historyRecovery.error.server";
  return "workspace.historyRecovery.error.invalid";
}

export function historyRecoveryCopy(state: HistoryRecoveryViewState, t: Translator): { title: string; detail: string } {
  if (state.phase === "requesting") return { title: t("workspace.historyRecovery.requesting.title"), detail: t("workspace.historyRecovery.requesting.detail") };
  if (state.phase === "transferring") return { title: t("workspace.historyRecovery.transferring.title"), detail: t("workspace.historyRecovery.transferring.detail") };
  if (state.phase === "importing") return { title: t("workspace.historyRecovery.importing.title"), detail: t("workspace.historyRecovery.importing.detail") };
  if (state.phase === "failed") return { title: t("workspace.historyRecovery.failed.title"), detail: t(state.errorKey ?? "workspace.historyRecovery.failed.detail") };
  return { title: t("workspace.historyRecovery.waiting.title"), detail: t("workspace.historyRecovery.waiting.detail") };
}
