import { IconKey } from "@tabler/icons-solidjs";
import { backupHealth } from "../backup-health";
import type { LocalBackupExport } from "../local-profiles";

export function BackupHealthPanel(props: { backup: LocalBackupExport | null; onBackup: () => void }) {
  const health = () => backupHealth(props.backup);
  return <section aria-labelledby="local-backup-heading" class="border-b border-black/5 p-5">
    <div class="flex items-start gap-3">
      <IconKey class={`mt-0.5 size-4 shrink-0 ${health().attention ? "stroke-amber-600" : "stroke-emerald-600"}`}/>
      <div class="min-w-0 flex-1">
        <h2 id="local-backup-heading" class="text-sm font-medium text-ink">加密本机备份</h2>
        <p class={`mt-1 text-xs/5 ${health().attention ? "text-amber-800" : "text-emerald-700"}`} role="status">{health().title}</p>
        <p class="mt-1 text-xs/5 text-muted">{health().detail}</p>
        <button type="button" class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10" onClick={props.onBackup}>创建新备份</button>
      </div>
    </div>
  </section>;
}
