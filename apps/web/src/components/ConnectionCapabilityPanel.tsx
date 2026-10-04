import { Show, createSignal } from "solid-js";
import { IconNetwork, IconRefresh } from "@tabler/icons-solidjs";
import { useI18n } from "../i18n";

export type ConnectionState = "online" | "syncing" | "offline";
export type TransportMode = "websocket" | "https";

export function ConnectionCapabilityPanel(props: {
  state: ConnectionState;
  mode: TransportMode;
  httpsOnly: boolean;
  onHttpsOnly: (enabled: boolean) => Promise<void>;
  onRetryRealtime: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [preferenceBusy, setPreferenceBusy] = createSignal(false);
  const [preferenceFailed, setPreferenceFailed] = createSignal(false);
  const fallback = () => props.state !== "offline" && props.mode === "https";
  const status = () => props.state === "offline" ? t("devices.network.offline")
    : fallback() ? t("devices.network.compatibility") : props.state === "syncing" ? t("devices.network.syncing") : t("devices.network.realtime");
  const description = () => props.state === "offline" ? t("devices.network.offlineDescription")
    : fallback() ? t(props.httpsOnly ? "devices.network.compatibilityPreferredDescription" : "devices.network.compatibilityDescription") : props.state === "syncing" ? t("devices.network.syncingDescription") : t("devices.network.realtimeDescription");

  async function retry() {
    if (busy()) return;
    setBusy(true); setFailed(false);
    try { await props.onRetryRealtime(); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }

  async function changePreference() {
    if (preferenceBusy()) return;
    setPreferenceBusy(true); setPreferenceFailed(false);
    try { await props.onHttpsOnly(!props.httpsOnly); }
    catch { setPreferenceFailed(true); }
    finally { setPreferenceBusy(false); }
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
        <div class="mt-3 flex items-start justify-between gap-4 rounded-lg bg-neutral-50 px-3 py-2.5">
          <div class="min-w-0">
            <strong class="block text-xs font-semibold text-ink">{t("devices.network.httpsOnly")}</strong>
            <p class="mt-0.5 text-xs/5 text-muted">{t("devices.network.httpsOnlyDescription")}</p>
          </div>
          <button type="button" role="switch" aria-label={t("devices.network.httpsOnly")} aria-checked={props.httpsOnly} disabled={preferenceBusy()} class={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${props.httpsOnly ? "bg-brand" : "bg-neutral-300"}`} onClick={() => void changePreference()}>
            <span class={`absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform ${props.httpsOnly ? "left-6" : "left-1"}`}/>
          </button>
        </div>
        <Show when={preferenceBusy()}><p class="mt-2 text-xs/5 text-muted" role="status">{t("devices.network.preferenceSaving")}</p></Show>
        <Show when={preferenceFailed()}><p class="mt-2 text-xs/5 text-red-600" role="alert">{t("devices.network.preferenceFailed")}</p></Show>
        <Show when={fallback() && !props.httpsOnly}>
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
