import { For, Show, createSignal } from "solid-js";
import { IconCheck, IconPlus, IconUserCircle } from "@tabler/icons-solidjs";
import { useI18n } from "../i18n";
import type { LocalProfile } from "../local-profiles";
import { Dialog } from "./primitives";
import { operationErrorMessage } from "../operation-errors";

export function LocalProfilesDialog(props: {
  profiles: LocalProfile[];
  activeProfileId: string;
  onSelect: (profileId: string) => Promise<void>;
  onAdd: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  async function run(key: string, operation: () => Promise<void>) {
    if (busy()) return;
    setBusy(key); setError("");
    try { await operation(); }
    catch (cause) { setError(operationErrorMessage(cause, t("localProfiles.error"), t)); setBusy(null); }
  }
  return <Dialog id="local-profiles" title={t("localProfiles.title")} description={t("localProfiles.description")} onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="p-3">
      <div class="divide-y divide-black/5"><For each={props.profiles}>{(profile) => {
        const active = () => profile.profile_id === props.activeProfileId;
        return <button type="button" disabled={Boolean(busy()) || active()} class="grid min-h-16 w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 text-left hover:bg-neutral-100 disabled:cursor-default disabled:opacity-70" onClick={() => void run(profile.profile_id, () => props.onSelect(profile.profile_id))}>
          <span class="grid size-10 place-items-center rounded-full bg-brand-soft"><IconUserCircle class="size-5 stroke-brand"/></span>
          <span class="min-w-0"><strong class="block truncate text-sm font-semibold text-ink">{profile.display_name}</strong><small class="mt-0.5 block truncate text-xs text-muted">{profile.user_id ?? t("localProfiles.signedOut")}</small></span>
          <Show when={active()} fallback={<span class="text-xs font-medium text-brand">{busy() === profile.profile_id ? t("localProfiles.switching") : t("localProfiles.switch")}</span>}><span class="flex items-center gap-1 text-xs font-medium text-emerald-700"><IconCheck class="size-4 stroke-emerald-600"/>{t("localProfiles.current")}</span></Show>
        </button>;
      }}</For></div>
      <Show when={error()}><p role="alert" class="mx-2 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error()}</p></Show>
      <button type="button" disabled={Boolean(busy())} class="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:opacity-50" onClick={() => void run("new", props.onAdd)}><IconPlus class="size-4 stroke-brand"/>{busy() === "new" ? t("localProfiles.creating") : t("localProfiles.add")}</button>
      <p class="px-2 pb-2 pt-3 text-xs/5 text-muted">{t("localProfiles.notice")}</p>
    </div>
  </Dialog>;
}
