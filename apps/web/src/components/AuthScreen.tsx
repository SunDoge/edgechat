import { Show, createSignal } from "solid-js";
import { IconQrcode, IconShieldLock, IconUpload } from "@tabler/icons-solidjs";
import { OpenMlsMessagingCore, type DeviceIdentity, type WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { ApiClient, SessionIdentity } from "@edgechat/sync";
import type { LocalDatabase } from "@edgechat/db";
import { loadIdentity, saveIdentity } from "../vault";
import { authErrorMessage } from "../auth-errors";
import { Brand, Input } from "./primitives";
import { DeviceLinkSetup } from "./DeviceLinkSetup";

export function AuthScreen(props: { api: ApiClient; core: WebCryptoMessagingCore; db: LocalDatabase; onReady: (session: SessionIdentity, identity: DeviceIdentity, token: string, mls: OpenMlsMessagingCore, restoredHistory?: boolean) => void; onRestoreBackup: (file: File, password: string, accountPassword: string) => Promise<void> }) {
  const restoredUserHint = sessionStorage.getItem("edgechat.restore-user-id") ?? "";
  const restoreCheckpoint = sessionStorage.getItem("edgechat.restore-checkpoint") ?? "";
  const finishingRestore = Boolean(restoreCheckpoint);
  if (restoredUserHint) sessionStorage.removeItem("edgechat.restore-user-id");
  const [mode, setMode] = createSignal<"register" | "login" | "link">(restoredUserHint ? "login" : "register");
  const [username, setUsername] = createSignal(restoredUserHint);
  const [displayName, setDisplayName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  const [restoreFile, setRestoreFile] = createSignal<File | null>(null);
  const [restorePassword, setRestorePassword] = createSignal("");
  const [restoreAccountPassword, setRestoreAccountPassword] = createSignal("");
  const [restoreConfirmed, setRestoreConfirmed] = createSignal(false);
  const [restoreBusy, setRestoreBusy] = createSignal(false);
  const [restoreError, setRestoreError] = createSignal("");

  async function submit(event: SubmitEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const existing = await loadIdentity();
      const identity = existing ?? await props.core.createIdentity();
      const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
      const mlsKeyPackages = mls.generateKeyPackages(12);
      const publicKeys = await props.core.exportPublicIdentity(identity);
      const device = {
        device_id: identity.deviceId, display_name: navigator.userAgent.includes("Mobile") ? "移动浏览器" : "网页浏览器",
        ...publicKeys, mls_key_packages: mlsKeyPackages,
        ...(restoreCheckpoint ? { backup_checkpoint: restoreCheckpoint } : {}),
        ...(identity.recoveryCredential ? { restore_credential: identity.recoveryCredential } : {}),
      };
      const stored = { ...identity, mlsState: mls.exportState() }; await saveIdentity(stored);
      const result = mode() === "register"
        ? await props.api.register({ localpart: username(), display_name: displayName(), password: password(), device })
        : await props.api.login({ user_id: username(), password: password(), device });
      const authenticatedIdentity = result.device_credential ? { ...stored, recoveryCredential: result.device_credential } : stored;
      if (authenticatedIdentity !== stored) await saveIdentity(authenticatedIdentity);
      sessionStorage.removeItem("edgechat.restore-checkpoint");
      props.onReady(result, authenticatedIdentity, result.access_token, mls);
    } catch (cause) { setError(authErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function restore(event: SubmitEvent) {
    event.preventDefault();
    const file = restoreFile();
    if (!file || !restorePassword() || !restoreAccountPassword() || !restoreConfirmed() || restoreBusy()) return;
    setRestoreBusy(true); setRestoreError("");
    try { await props.onRestoreBackup(file, restorePassword(), restoreAccountPassword()); }
    catch (cause) { setRestoreError(cause instanceof Error ? cause.message : "无法恢复备份"); setRestoreBusy(false); }
  }

  const RestoreForm = () => <form class="grid gap-4 rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5" onSubmit={restore}>
    <div><h1 class="text-lg font-semibold text-ink">恢复这台设备</h1><p class="mt-1 text-sm/5 text-muted">先完整验证文件和服务器检查点，再替换本机消息库。恢复后仍需登录。</p></div>
    <label class="grid gap-2 text-sm font-medium text-ink" for="backup-file">备份文件<input id="backup-file" name="backup_file" type="file" accept=".edgechat-backup,application/vnd.edgechat.backup" required class="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink file:ring-1 file:ring-black/10" onChange={(event) => setRestoreFile(event.currentTarget.files?.[0] ?? null)}/></label>
    <Input label="备份密码" id="restore-password" name="restore_password" type="password" autocomplete="current-password" value={restorePassword()} onInput={(event) => setRestorePassword(event.currentTarget.value)} required/>
    <Input label="账户密码" id="restore-account-password" name="restore_account_password" type="password" autocomplete="current-password" value={restoreAccountPassword()} onInput={(event) => setRestoreAccountPassword(event.currentTarget.value)} required/>
    <label class="flex items-start gap-2 text-xs/5 text-muted"><input type="checkbox" class="mt-1 size-4 accent-brand" checked={restoreConfirmed()} onChange={(event) => setRestoreConfirmed(event.currentTarget.checked)}/><span>我明白恢复会替换这个浏览器里的 EdgeChat 消息和设备身份，并且不会同时使用旧副本。</span></label>
    <Show when={restoreError()}><p role="alert" class="text-sm text-red-600">{restoreError()}</p></Show>
    <div class="flex justify-end gap-2"><button type="button" disabled={restoreBusy()} class="h-10 rounded-lg px-3 text-sm font-medium text-ink hover:bg-white" onClick={() => setRestoreOpen(false)}>取消</button><button type="submit" disabled={!restoreFile() || !restorePassword() || !restoreAccountPassword() || !restoreConfirmed() || restoreBusy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:bg-neutral-300">{restoreBusy() ? "正在验证…" : "验证并恢复"}</button></div>
  </form>;

  return <main class="isolate grid min-h-dvh place-items-center bg-white px-6 py-10 antialiased"><section class="w-full max-w-xs">
    <header class="mb-10 flex justify-center"><Brand/></header>
    <Show when={!restoreOpen()} fallback={<RestoreForm/>}>
    <Show when={mode() === "link"} fallback={<>
    <Show when={!finishingRestore}><div class="mb-8 grid grid-cols-2 rounded-lg bg-neutral-100 p-1" role="tablist" aria-label="账户操作">
      <button type="button" role="tab" aria-selected={mode() === "register"} class="h-9 rounded-md text-sm font-medium text-muted aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-sm" onClick={() => setMode("register")}>创建账户</button>
      <button type="button" role="tab" aria-selected={mode() === "login"} class="h-9 rounded-md text-sm font-medium text-muted aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-sm" onClick={() => setMode("login")}>登录</button>
    </div></Show>
    <div class="mb-7"><h1 class="text-balance text-2xl font-semibold tracking-tight text-ink">{finishingRestore ? "完成设备恢复" : mode() === "register" ? "创建你的身份" : "欢迎回来"}</h1><p class="mt-2 text-base/6 text-muted">{finishingRestore ? "输入账户密码，服务器会再次确认恢复检查点。" : mode() === "register" ? "密钥只在这台设备上生成和保存。" : "新浏览器会注册为一台独立设备。"}</p></div>
    <form class="grid gap-5" onSubmit={submit}>
      <Show when={mode() === "register"}><Input label="显示名称" id="display-name" name="display_name" value={displayName()} onInput={(event) => setDisplayName(event.currentTarget.value)} maxLength={60} required autofocus/></Show>
      <Input label="用户名" id="username" name="username" value={username()} onInput={(event) => setUsername(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_.@:-]/g, ""))} placeholder={mode() === "register" ? "alice" : "@alice:localhost"} autocomplete="username" required/>
      <Input label="密码" id="password" name="password" type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} minLength={10} autocomplete={mode() === "register" ? "new-password" : "current-password"} required/>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error()}</div></Show>
      <button type="submit" class="h-11 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:bg-neutral-300" disabled={busy()}>{busy() ? "正在准备设备…" : mode() === "register" ? "创建并继续" : "登录"}</button>
    </form>
    <Show when={!finishingRestore}><div class="my-7 flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>或<span class="h-px flex-1 bg-black/10"/></div>
    <div class="grid gap-2"><button type="button" class="flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-brand ring-1 ring-inset ring-brand/30 hover:bg-brand-soft" onClick={() => setMode("link")}><IconQrcode class="size-4 stroke-brand"/>链接已有账户</button><button type="button" class="flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-muted hover:bg-neutral-50" onClick={() => setRestoreOpen(true)}><IconUpload class="size-4 stroke-muted"/>从加密备份恢复</button></div></Show>
    </>}><DeviceLinkSetup api={props.api} core={props.core} db={props.db} onReady={props.onReady} onCancel={() => setMode("login")}/></Show>
    </Show>
    <div class="mt-7 flex items-start gap-2 text-sm/5 text-muted"><IconShieldLock class="mt-0.5 size-4 shrink-0 stroke-muted"/><p>消息会在本机解密并存入 PGlite。使用共享设备后请退出账户。</p></div>
  </section></main>;
}
