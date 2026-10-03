import { IconKey } from "@tabler/icons-solidjs";
import { backupHealth } from "../backup-health";
import type { LocalBackupExport } from "../local-profiles";
import { useI18n } from "../i18n";

export function BackupHealthPanel(props: { backup: LocalBackupExport | null; onBackup: () => void }) {
  const { locale, t } = useI18n();
  const health = () => backupHealth(props.backup);
  const delivery = () => health().delivery === "confirmed_file" ? t("backupHealth.confirmed") : t("backupHealth.downloadStarted");
  const date = () => health().createdAt === null ? "" : new Date(health().createdAt!).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
  const title = () => health().state === "missing" ? t("backupHealth.missingTitle") : health().state === "stale" ? t("backupHealth.staleTitle") : t("backupHealth.createdAt", { date: date() });
  const detail = () => health().state === "missing" ? t("backupHealth.missingDetail") : health().state === "stale" ? `${t("backupHealth.createdAt", { date: date() })}。${delivery()}` : t("backupHealth.healthyDetail", { delivery: delivery() });
  return <section aria-labelledby="local-backup-heading" class="border-b border-black/5 p-5">
    <div class="flex items-start gap-3">
      <IconKey class={`mt-0.5 size-4 shrink-0 ${health().attention ? "stroke-amber-600" : "stroke-emerald-600"}`}/>
      <div class="min-w-0 flex-1">
        <h2 id="local-backup-heading" class="text-sm font-medium text-ink">{t("backupHealth.title")}</h2>
        <p class={`mt-1 text-xs/5 ${health().attention ? "text-amber-800" : "text-emerald-700"}`} role="status">{title()}</p>
        <p class="mt-1 text-xs/5 text-muted">{detail()}</p>
        <button type="button" class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10" onClick={props.onBackup}>{t("backupHealth.action")}</button>
      </div>
    </div>
  </section>;
}
