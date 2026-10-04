import { Show, createSignal } from "solid-js";
import { IconNetwork, IconRefresh } from "@tabler/icons-solidjs";
import { useI18n } from "../i18n";

export type ConnectionState = "online" | "syncing" | "offline";
export type TransportMode = "websocket" | "https";

export function ConnectionCapabilityPanel(props: {
  state: ConnectionState;
  mode: TransportMode;
  onRetryRealtime: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const fallback = () => props.state !== "offline" && props.mode === "https";
  const status = () => props.state === "offline" ? t("devices.network.offline")
    : fallback() ? t("devices.network.compatibility") : props.state === "syncing" ? t("devices.network.syncing") : t("devices.network.realtime");
  const description = () => props.state === "offline" ? t("devices.network.offlineDescription")
    : fallback() ? t("devices.network.compatibilityDescription") : props.state === "syncing" ? t("devices.network.syncingDescription") : t("devices.network.realtimeDescription");

  async function retry() {
    if (busy()) return;
    setBusy(true); setFailed(false);
    try { await props.onRetryRealtime(); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }

  return <section class="border-b border-black/5 p-5" aria-labelledby="device-network-heading">
    <div class="flex items-start gap-3">
      <IconNetwork class="mt-0.5 size-4 shrink-0 stroke-muted"/>
      <div class="min-w-0 flex-1">
        <strong id="device-network-heading" class="text-sm font-medium text-ink">{t("devices.network.title")}</strong>
        <p class="mt-1 flex items-center gap-2 text-xs/5" role="status" aria-live="polite">
          <span aria-hidden="true" class={`size-1.5 shrink-0 rounded-full ${props.state === "offline" ? "bg-neutral-400" : fallback() || props.state === "syncing" ? "bg-amber-500" : "bg-emerald-500"}`}/>
          <span class="font-medium text-ink">{status()}</span>
        </p>
        <p class="mt-1 text-xs/5 text-muted">{description()}</p>
        <Show when={fallback()}>
          <button type="button" disabled={busy()} class="mt-3 flex min-h-10 items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:text-neutral-400" onClick={() => void retry()}>
            <IconRefresh class={`size-4 ${busy() ? "animate-spin" : ""}`}/>{busy() ? t("devices.network.retrying") : t("devices.network.retry")}
          </button>
        </Show>
        <Show when={failed()}><p class="mt-2 text-xs/5 text-red-600" role="alert">{t("devices.network.retryFailed")}</p></Show>
        <details class="mt-3 text-xs/5 text-muted">
          <summary class="min-h-9 cursor-pointer py-2 font-semibold text-brand">{t("devices.network.browserLimits")}</summary>
          <p>{t("devices.network.browserLimitsDescription")}</p>
        </details>
      </div>
    </div>
  </section>;
}
