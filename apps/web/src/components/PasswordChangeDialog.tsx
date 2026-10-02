import { Show, createSignal } from "solid-js";
import { Dialog, Input } from "./primitives";

export function PasswordChangeDialog(props: {
  onChange: (currentPassword: string, newPassword: string, logoutOtherDevices: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [logoutOtherDevices, setLogoutOtherDevices] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const valid = () => currentPassword().length > 0 && newPassword().length >= 10
    && newPassword() !== currentPassword() && newPassword() === confirmation();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid() || busy()) return;
    setBusy(true); setError("");
    try { await props.onChange(currentPassword(), newPassword(), logoutOtherDevices()); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法修改登录密码"); }
    finally { setBusy(false); }
  }

  return <Dialog id="change-password" title="修改登录密码" description="消息加密密钥不会随登录密码改变" onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <Input label="当前密码" id="current-account-password" name="current_password" type="password" autocomplete="current-password" value={currentPassword()} onInput={(event) => setCurrentPassword(event.currentTarget.value)} autofocus/>
      <Input label="新密码" id="new-account-password" name="new_password" type="password" minLength={10} autocomplete="new-password" value={newPassword()} onInput={(event) => setNewPassword(event.currentTarget.value)}/>
      <Input label="再次输入新密码" id="new-account-password-confirmation" name="new_password_confirmation" type="password" minLength={10} autocomplete="new-password" value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)}/>
      <p class="text-xs/5 text-muted">至少 10 个字符，并且不能与当前密码相同。</p>
      <label class="flex items-start gap-3 rounded-lg bg-neutral-50 p-3 text-sm/5 text-ink">
        <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-brand" checked={logoutOtherDevices()} onChange={(event) => setLogoutOtherDevices(event.currentTarget.checked)}/>
        <span><strong class="block font-medium">退出其他设备</strong><small class="mt-1 block text-xs/5 text-muted">立即停止其他设备访问服务器和接收 Push；不会远程删除它们已经保存的本地消息，也不会撤销 MLS 设备身份。</small></span>
      </label>
      <Show when={confirmation() && newPassword() !== confirmation()}><p role="alert" class="text-sm text-red-600">两次输入的新密码不一致</p></Show>
      <Show when={newPassword() && newPassword() === currentPassword()}><p role="alert" class="text-sm text-red-600">新密码不能与当前密码相同</p></Show>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="mt-1 flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="submit" disabled={!valid() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? "正在修改…" : "修改密码"}</button></div>
    </form>
  </Dialog>;
}
