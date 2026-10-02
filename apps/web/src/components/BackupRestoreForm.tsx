import { Show, createSignal } from "solid-js";
import { Input } from "./primitives";

export function BackupRestoreForm(props: {
  onRestore: (file: File, password: string, accountPassword: string) => Promise<void>;
  onCancel: () => void;
  title?: string;
  description?: string;
}) {
  const [file, setFile] = createSignal<File | null>(null);
  const [password, setPassword] = createSignal("");
  const [accountPassword, setAccountPassword] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function restore(event: SubmitEvent) {
    event.preventDefault();
    const backup = file();
    if (!backup || !password() || !accountPassword() || !confirmed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onRestore(backup, password(), accountPassword()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法恢复备份"); }
    finally { setBusy(false); }
  }

  return <form class="grid gap-4 rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5" onSubmit={restore}>
    <div><h2 class="text-lg font-semibold text-ink">{props.title ?? "恢复这台设备"}</h2><p class="mt-1 text-sm/5 text-muted">{props.description ?? "先完整验证文件和服务器检查点，再替换本机消息库。恢复后仍需登录。"}</p></div>
    <label class="grid gap-2 text-sm font-medium text-ink" for="backup-file">备份文件<input id="backup-file" name="backup_file" type="file" accept=".edgechat-backup,application/vnd.edgechat.backup" required class="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink file:ring-1 file:ring-black/10" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}/></label>
    <Input label="备份密码" id="restore-password" name="restore_password" type="password" autocomplete="current-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} required/>
    <Input label="账户密码" id="restore-account-password" name="restore_account_password" type="password" autocomplete="current-password" value={accountPassword()} onInput={(event) => setAccountPassword(event.currentTarget.value)} required/>
    <label class="flex items-start gap-2 text-xs/5 text-muted"><input type="checkbox" class="mt-1 size-4 accent-brand" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)}/><span>我明白恢复会在完整验证后替换这个本机身份的消息与设备密钥，并且不会同时使用旧副本。</span></label>
    <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
    <div class="flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-3 text-sm font-medium text-ink hover:bg-white disabled:text-neutral-400" onClick={props.onCancel}>取消</button><button type="submit" disabled={!file() || !password() || !accountPassword() || !confirmed() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:bg-neutral-300">{busy() ? "正在验证…" : "验证并恢复"}</button></div>
  </form>;
}
