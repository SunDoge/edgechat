import { Show, createSignal } from "solid-js";
import { IconDatabase } from "@tabler/icons-solidjs";
import { localStorageRatio, type LocalStorageHealth, type PersistenceRequestResult } from "../local-storage-health";
import { useI18n } from "../i18n";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function LocalStoragePanel(props: {
  health: LocalStorageHealth | null;
  onRequestPersistence: () => Promise<PersistenceRequestResult>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<PersistenceRequestResult["outcome"] | null>(null);
  const [override, setOverride] = createSignal<LocalStorageHealth | null>(null);
  const health = () => override() ?? props.health;
  const ratio = () => health() ? localStorageRatio(health()!) : null;
  const hasEstimate = () => health()?.usage !== null && health()?.usage !== undefined && health()?.quota !== null && health()?.quota !== undefined;

  async function protect() {
    if (busy()) return;
    setBusy(true); setResult(null);
    try {
      const response = await props.onRequestPersistence();
      setOverride(response.health); setResult(response.outcome);
    } catch { setResult("error"); }
    finally { setBusy(false); }
  }

  const persistenceCopy = () => {
    const state = health()?.persistence;
    if (state === "persistent") return { tone: "text-emerald-700", text: t("localStorage.persistent") };
    if (state === "best-effort") return { tone: "text-amber-700", text: t("localStorage.bestEffort") };
    if (state === "unsupported") return { tone: "text-muted", text: t("localStorage.unsupported") };
    return { tone: "text-muted", text: t("localStorage.unknown") };
  };

  return <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconDatabase class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1">
    <div class="flex items-baseline justify-between gap-3"><strong class="text-sm font-medium text-ink">{t("localStorage.title")}</strong><Show when={hasEstimate()} fallback={<span class="text-xs text-muted">{props.health ? t("localStorage.estimateUnavailable") : t("localStorage.loading")}</span>}><span class="text-xs tabular-nums text-muted">{t("localStorage.usage", { usage: formatBytes(health()!.usage!), quota: formatBytes(health()!.quota!) })}</span></Show></div>
    <Show when={ratio() !== null}><div class="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label={t("localStorage.aria")} aria-valuemin="0" aria-valuemax={health()!.quota!} aria-valuenow={health()!.usage!}><div class={`h-full rounded-full ${ratio()! >= 0.9 ? "bg-red-500" : ratio()! >= 0.75 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${ratio()! * 100}%` }}/></div></Show>
    <Show when={health()} fallback={<p class="mt-2 text-xs/5 text-muted">{t("localStorage.checking")}</p>}>
      <p class={`mt-2 text-xs/5 ${persistenceCopy().tone}`} role="status">{persistenceCopy().text}</p>
      <Show when={ratio() !== null && ratio()! >= 0.8}><p class="mt-1 text-xs/5 text-red-600">{t("localStorage.pressure")}</p></Show>
      <Show when={health()!.canRequestPersistence && health()!.persistence !== "persistent"}><button type="button" disabled={busy()} class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:text-neutral-400" onClick={() => void protect()}>{busy() ? t("localStorage.requesting") : t("localStorage.protect")}</button></Show>
      <Show when={result() === "denied"}><p class="mt-2 text-xs/5 text-amber-700" role="status">{t("localStorage.denied")}</p></Show>
      <Show when={result() === "error"}><p class="mt-2 text-xs/5 text-red-600" role="alert">{t("localStorage.error")}</p></Show>
    </Show>
    <p class="mt-2 text-xs/5 text-muted">{t("localStorage.notice")}</p>
  </div></div></div>;
}
