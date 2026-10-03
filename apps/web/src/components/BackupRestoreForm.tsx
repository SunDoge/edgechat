import { Show, createSignal } from "solid-js";
import { Input } from "./primitives";
import { useI18n } from "../i18n";

export function BackupRestoreForm(props: {
  onRestore: (file: File, password: string) => Promise<void>;
  onCancel: () => void;
  title?: string;
  description?: string;
}) {
  const { t } = useI18n();
  const [file, setFile] = createSignal<File | null>(null);
  const [password, setPassword] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function restore(event: SubmitEvent) {
    event.preventDefault();
    const backup = file();
    if (!backup || !password() || !confirmed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onRestore(backup, password()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("backup.restore.error")); }
    finally { setBusy(false); }
  }

  return <form class="grid gap-4 rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5" onSubmit={restore}>
    <div><h2 class="text-lg font-semibold text-ink">{props.title ?? t("backup.restore.title")}</h2><p class="mt-1 text-sm/5 text-muted">{props.description ?? t("backup.restore.description")}</p></div>
    <label class="grid gap-2 text-sm font-medium text-ink" for="backup-file">{t("backup.restore.file")}<input id="backup-file" name="backup_file" type="file" accept=".edgechat-backup,application/vnd.edgechat.backup" required class="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink file:ring-1 file:ring-black/10" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}/></label>
    <Input label={t("backup.restore.password")} id="restore-password" name="restore_password" type="password" autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} required/>
    <label class="flex items-start gap-2 text-xs/5 text-muted"><input type="checkbox" class="mt-1 size-4 accent-brand" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)}/><span>{t("backup.restore.confirmation")}</span></label>
    <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
    <div class="flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-3 text-sm font-medium text-ink hover:bg-white disabled:text-neutral-400" onClick={props.onCancel}>{t("common.cancel")}</button><button type="submit" disabled={!file() || !password() || !confirmed() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:bg-neutral-300">{busy() ? t("backup.restore.loading") : t("backup.restore.submit")}</button></div>
  </form>;
}
