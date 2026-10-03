import { Show, createSignal } from "solid-js";
import { useI18n } from "../i18n";
import { operationErrorMessage } from "../operation-errors";
import { Dialog, Input } from "./primitives";

export function BackupDialog(props: { onCreate: (password: string, includeCachedMedia: boolean) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [includeCachedMedia, setIncludeCachedMedia] = createSignal(true);
  const valid = () => password().length >= 12 && password() === confirmation();
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid() || busy()) return;
    setBusy(true); setError("");
    try { await props.onCreate(password(), includeCachedMedia()); props.onClose(); }
    catch (cause) { setError(operationErrorMessage(cause, t("backup.create.error"), t)); }
    finally { setBusy(false); }
  }
  return <Dialog id="portable-backup" title={t("backup.create.title")} description={t("backup.create.description")} onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">{t("backup.create.warning")}</div>
      <label class="flex items-start gap-3 rounded-xl bg-neutral-50 px-3 py-3 ring-1 ring-black/5" for="backup-cached-media"><input id="backup-cached-media" type="checkbox" checked={includeCachedMedia()} disabled={busy()} class="mt-1 size-4 accent-brand" onChange={(event) => setIncludeCachedMedia(event.currentTarget.checked)}/><span class="min-w-0"><strong class="block text-sm font-semibold text-ink">{t("backup.create.includeMedia")}</strong><span class="mt-0.5 block text-xs/5 text-muted">{t("backup.create.includeMediaHelp")}</span></span></label>
      <Input label={t("backup.create.password")} id="backup-password" name="backup_password" type="password" minLength={12} autocomplete="new-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autofocus/>
      <Input label={t("backup.create.confirmPassword")} id="backup-confirmation" name="backup_confirmation" type="password" minLength={12} autocomplete="new-password" value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)}/>
      <p class="text-xs/5 text-muted">{t("backup.create.storageNotice")}</p>
      <Show when={confirmation() && password() !== confirmation()}><p role="alert" class="text-sm text-red-600">{t("backup.create.mismatch")}</p></Show>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="mt-1 flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>{t("common.cancel")}</button><button type="submit" disabled={!valid() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? t("backup.create.encrypting") : t("backup.create.action")}</button></div>
    </form>
  </Dialog>;
}
