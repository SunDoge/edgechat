import { Show, createSignal } from "solid-js";
import { IconAlertTriangle, IconRefresh, IconSwitchHorizontal, IconUpload } from "@tabler/icons-solidjs";
import type { StartupFailure } from "../startup-recovery";
import { useI18n } from "../i18n";
import { BackupRestoreForm } from "./BackupRestoreForm";
import { Brand } from "./primitives";

export function StartupRecoveryScreen(props: {
  failure: StartupFailure;
  profileName: string;
  inactive?: boolean;
  onRetry: () => void;
  onManageProfiles: () => void;
  onRestoreBackup: (file: File, password: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  return <main inert={props.inactive ? true : undefined} class="isolate grid min-h-dvh place-items-center bg-chat px-5 py-10 antialiased">
    <section class="w-full max-w-md rounded-2xl bg-white p-6 shadow-message ring-1 ring-black/5" aria-labelledby="startup-recovery-title">
      <header class="mb-6 flex items-center justify-between"><Brand/><span class="max-w-40 truncate text-xs text-muted">{props.profileName}</span></header>
      <Show when={!restoreOpen()} fallback={<BackupRestoreForm title={t("startupRecovery.restoreBackup")} description={t("startupRecovery.restoreDescription")} onRestore={props.onRestoreBackup} onCancel={() => setRestoreOpen(false)}/>}>
        <div class="grid size-11 place-items-center rounded-full bg-amber-100"><IconAlertTriangle class="size-5 stroke-amber-700"/></div>
        <h1 id="startup-recovery-title" class="mt-4 text-xl font-semibold tracking-tight text-ink">{t(props.failure.titleKey)}</h1>
        <p class="mt-2 text-sm/6 text-muted">{t(props.failure.summaryKey)}</p>
        <div class="mt-6 grid gap-2">
          <button type="button" autofocus class="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => props.failure.primaryIntent === "restore" ? setRestoreOpen(true) : props.onRetry()}><Show when={props.failure.primaryIntent === "restore"} fallback={<IconRefresh class="size-4 stroke-white"/>}><IconUpload class="size-4 stroke-white"/></Show>{t(props.failure.primaryActionKey)}</button>
          <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-ink ring-1 ring-inset ring-black/10 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={props.onManageProfiles}><IconSwitchHorizontal class="size-4 stroke-muted"/>{t("startupRecovery.switchProfile")}</button>
          <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-muted hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => setRestoreOpen(true)}><IconUpload class="size-4 stroke-muted"/>{t("startupRecovery.restoreBackup")}</button>
        </div>
        <p class="mt-5 rounded-lg bg-emerald-50 px-3 py-2.5 text-xs/5 text-emerald-800">{t("startupRecovery.nonDestructive")}</p>
        <details class="mt-4 text-xs text-muted"><summary class="cursor-pointer select-none py-1 font-medium">{t("startupRecovery.diagnostics")}</summary><code class="mt-1 block break-all rounded-md bg-neutral-100 px-2 py-1.5">{props.failure.code}</code></details>
      </Show>
    </section>
  </main>;
}
