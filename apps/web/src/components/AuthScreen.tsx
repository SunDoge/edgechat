import { Show, createSignal } from "solid-js";
import { IconQrcode, IconShieldLock, IconSwitchHorizontal, IconUpload } from "@tabler/icons-solidjs";
import { OpenMlsMessagingCore, type DeviceIdentity, type WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { AccountAppealCategory, AccountAppealStatus, ApiClient, SessionIdentity } from "@edgechat/sync";
import type { LocalDatabase } from "@edgechat/db";
import { loadIdentity, saveIdentity } from "../vault";
import { authErrorMessage } from "../auth-errors";
import { Brand, Input } from "./primitives";
import { DeviceLinkSetup } from "./DeviceLinkSetup";
import { BackupRestoreForm } from "./BackupRestoreForm";
import { profileSessionKey } from "../local-profiles";
import { useI18n } from "../i18n";

export function AuthScreen(props: { profileId: string; api: ApiClient; core: WebCryptoMessagingCore; db: LocalDatabase; onReady: (session: SessionIdentity, identity: DeviceIdentity, token: string, mls: OpenMlsMessagingCore, restoredHistory?: boolean) => void; onRestoreBackup: (file: File, password: string, accountPassword: string) => Promise<void>; onManageProfiles: () => void }) {
  const { t } = useI18n();
  const restoreUserKey = profileSessionKey(props.profileId, "restore-user-id");
  const restoreCheckpointKey = profileSessionKey(props.profileId, "restore-checkpoint");
  const restorePhaseKey = profileSessionKey(props.profileId, "restore-phase");
  const appealReceiptKey = profileSessionKey(props.profileId, "account-appeal-receipt");
  const restoredUserHint = sessionStorage.getItem(restoreUserKey) ?? "";
  const restoreCheckpoint = sessionStorage.getItem(restoreCheckpointKey) ?? "";
  const finishingRestore = Boolean(restoreCheckpoint);
  if (restoredUserHint) sessionStorage.removeItem(restoreUserKey);
  const [mode, setMode] = createSignal<"register" | "login" | "link">(restoredUserHint ? "login" : "register");
  const [username, setUsername] = createSignal(restoredUserHint);
  const [displayName, setDisplayName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  const [appealOpen, setAppealOpen] = createSignal(false);
  const [appealCategory, setAppealCategory] = createSignal<AccountAppealCategory>("login_locked");
  const [appealReceipt, setAppealReceipt] = createSignal(localStorage.getItem(appealReceiptKey) ?? "");
  const [appealStatus, setAppealStatus] = createSignal<AccountAppealStatus | null>(null);
  const [appealBusy, setAppealBusy] = createSignal(false);
  const [appealError, setAppealError] = createSignal("");

  async function submit(event: SubmitEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const existing = await loadIdentity(props.profileId);
      const identity = existing ?? await props.core.createIdentity();
      const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
      const mlsKeyPackages = mls.generateKeyPackages(12);
      const publicKeys = await props.core.exportPublicIdentity(identity);
      const device = {
        device_id: identity.deviceId, display_name: navigator.userAgent.includes("Mobile") ? t("auth.device.mobile") : t("auth.device.desktop"),
        ...publicKeys, mls_key_packages: mlsKeyPackages,
        ...(restoreCheckpoint ? { backup_checkpoint: restoreCheckpoint } : {}),
        ...(identity.recoveryCredential ? { restore_credential: identity.recoveryCredential } : {}),
      };
      const stored = { ...identity, mlsState: mls.exportState() }; await saveIdentity(props.profileId, stored);
      const result = mode() === "register"
        ? await props.api.register({ localpart: username(), display_name: displayName(), password: password(), device })
        : await props.api.login({ user_id: username(), password: password(), device });
      const authenticatedIdentity = result.device_credential ? { ...stored, recoveryCredential: result.device_credential } : stored;
      if (authenticatedIdentity !== stored) await saveIdentity(props.profileId, authenticatedIdentity);
      sessionStorage.removeItem(restoreCheckpointKey);
      sessionStorage.removeItem(restorePhaseKey);
      props.onReady(result, authenticatedIdentity, result.access_token, mls);
    } catch (cause) { setError(authErrorMessage(cause, t)); }
    finally { setBusy(false); }
  }

  async function refreshAppealStatus(receipt = appealReceipt()) {
    if (!receipt) return;
    setAppealBusy(true); setAppealError("");
    try { setAppealStatus((await props.api.accountAppealStatus(receipt)).status); }
    catch (cause) { setAppealError(cause instanceof Error ? cause.message : t("auth.appeal.status.error")); }
    finally { setAppealBusy(false); }
  }

  async function submitAppeal(event: SubmitEvent) {
    event.preventDefault(); setAppealBusy(true); setAppealError("");
    try {
      const result = await props.api.createAccountAppeal(username(), password(), appealCategory());
      localStorage.setItem(appealReceiptKey, result.receipt);
      setAppealReceipt(result.receipt); setAppealStatus(result.status);
    } catch (cause) { setAppealError(cause instanceof Error ? cause.message : t("auth.appeal.submit.error")); }
    finally { setAppealBusy(false); }
  }

  const AppealForm = () => <div class="grid gap-5">
    <div><h1 class="text-2xl font-semibold tracking-tight text-ink">{t("auth.appeal.title")}</h1><p class="mt-2 text-sm/6 text-muted">{t("auth.appeal.description")}</p></div>
    <Show when={!appealReceipt()} fallback={<div class="grid gap-4 rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5">
      <div><p class="text-sm font-semibold text-ink">{t("auth.appeal.status.title")}</p><p class="mt-1 text-sm text-muted">{appealStatus() === "approved" ? t("auth.appeal.status.approved") : appealStatus() === "denied" ? t("auth.appeal.status.denied") : appealStatus() === "expired" ? t("auth.appeal.status.expired") : t("auth.appeal.status.pending")}</p></div>
      <Show when={appealError()}><p role="alert" class="text-sm text-red-600">{appealError()}</p></Show>
      <div class="flex gap-2"><button type="button" disabled={appealBusy()} class="h-10 rounded-lg bg-white px-3 text-sm font-medium text-ink ring-1 ring-black/10" onClick={() => void refreshAppealStatus()}>{appealBusy() ? t("auth.appeal.status.loading") : t("auth.appeal.status.refresh")}</button><button type="button" class="h-10 px-3 text-sm font-medium text-muted" onClick={() => { localStorage.removeItem(appealReceiptKey); setAppealReceipt(""); setAppealStatus(null); }}>{t("auth.appeal.submit.again")}</button></div>
    </div>}>
      <form class="grid gap-4" onSubmit={submitAppeal}>
        <Input label={t("auth.appeal.username")} id="appeal-username" name="appeal_username" value={username()} onInput={(event) => setUsername(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_.@:-]/g, ""))} placeholder="@alice:example.com" autocomplete="username" required/>
        <Input label={t("auth.appeal.password")} id="appeal-password" name="appeal_password" type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} minLength={10} autocomplete="current-password" required/>
        <label class="grid gap-2 text-sm font-medium text-ink" for="appeal-category">{t("auth.appeal.category")}<select id="appeal-category" class="h-11 rounded-lg bg-white px-3 text-sm ring-1 ring-inset ring-black/10 focus:outline-2 focus:outline-brand" value={appealCategory()} onChange={(event) => setAppealCategory(event.currentTarget.value as AccountAppealCategory)}><option value="login_locked">{t("auth.appeal.category.loginLocked")}</option><option value="device_lost">{t("auth.appeal.category.deviceLost")}</option><option value="account_access">{t("auth.appeal.category.accountAccess")}</option></select></label>
        <p class="text-xs/5 text-muted">{t("auth.appeal.passwordNotice")}</p>
        <Show when={appealError()}><p role="alert" class="text-sm text-red-600">{appealError()}</p></Show>
        <button type="submit" disabled={appealBusy()} class="h-11 rounded-lg bg-brand px-3 text-sm font-semibold text-white disabled:bg-neutral-300">{appealBusy() ? t("auth.appeal.submit.loading") : t("auth.appeal.submit.action")}</button>
      </form>
    </Show>
    <button type="button" class="justify-self-start text-sm font-medium text-brand" onClick={() => setAppealOpen(false)}>{t("auth.appeal.back")}</button>
  </div>;

  return <main class="isolate grid min-h-dvh place-items-center bg-white px-6 py-10 antialiased"><section class="w-full max-w-xs">
    <header class="mb-10 flex justify-center"><Brand/></header>
    <Show when={!appealOpen()} fallback={<AppealForm/>}>
    <Show when={!restoreOpen()} fallback={<BackupRestoreForm onRestore={props.onRestoreBackup} onCancel={() => setRestoreOpen(false)}/>}>
    <Show when={mode() === "link"} fallback={<>
    <Show when={!finishingRestore}><div class="mb-8 grid grid-cols-2 rounded-lg bg-neutral-100 p-1" role="tablist" aria-label={t("auth.tabs.label")}>
      <button type="button" role="tab" aria-selected={mode() === "register"} class="h-9 rounded-md text-sm font-medium text-muted aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-sm" onClick={() => setMode("register")}>{t("auth.register.tab")}</button>
      <button type="button" role="tab" aria-selected={mode() === "login"} class="h-9 rounded-md text-sm font-medium text-muted aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-sm" onClick={() => setMode("login")}>{t("common.login")}</button>
    </div></Show>
    <div class="mb-7"><h1 class="text-balance text-2xl font-semibold tracking-tight text-ink">{finishingRestore ? t("auth.restore.finishTitle") : mode() === "register" ? t("auth.register.title") : t("auth.login.title")}</h1><p class="mt-2 text-base/6 text-muted">{finishingRestore ? t("auth.restore.finishDescription") : mode() === "register" ? t("auth.register.description") : t("auth.login.description")}</p></div>
    <form class="grid gap-5" onSubmit={submit}>
      <Show when={mode() === "register"}><Input label={t("auth.displayName")} id="display-name" name="display_name" value={displayName()} onInput={(event) => setDisplayName(event.currentTarget.value)} maxLength={60} required autofocus/></Show>
      <Input label={t("auth.username")} id="username" name="username" value={username()} onInput={(event) => setUsername(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_.@:-]/g, ""))} placeholder={mode() === "register" ? "alice" : "@alice:localhost"} autocomplete="username" required/>
      <Input label={t("auth.password")} id="password" name="password" type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} minLength={10} autocomplete={mode() === "register" ? "new-password" : "current-password"} required/>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error()}</div></Show>
      <button type="submit" class="h-11 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:bg-neutral-300" disabled={busy()}>{busy() ? t("auth.submit.loading") : mode() === "register" ? t("auth.register.action") : t("common.login")}</button>
      <Show when={mode() === "login" && !finishingRestore}><button type="button" class="text-sm font-medium text-brand" onClick={() => { setAppealOpen(true); if (appealReceipt()) void refreshAppealStatus(); }}>{t("auth.login.appealAction")}</button></Show>
    </form>
    <Show when={!finishingRestore}><div class="my-7 flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>{t("auth.alternative")}<span class="h-px flex-1 bg-black/10"/></div>
    <div class="grid gap-2"><button type="button" class="flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-brand ring-1 ring-inset ring-brand/30 hover:bg-brand-soft" onClick={() => setMode("link")}><IconQrcode class="size-4 stroke-brand"/>{t("auth.link.action")}</button><button type="button" class="flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-muted hover:bg-neutral-50" onClick={() => setRestoreOpen(true)}><IconUpload class="size-4 stroke-muted"/>{t("auth.restore.action")}</button></div></Show>
    </>}><DeviceLinkSetup profileId={props.profileId} api={props.api} core={props.core} db={props.db} onReady={props.onReady} onCancel={() => setMode("login")}/></Show>
    </Show>
    </Show>
    <button type="button" class="mt-7 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-muted hover:bg-neutral-100" onClick={props.onManageProfiles}><IconSwitchHorizontal class="size-4 stroke-muted"/>{t("auth.profile.switch")}</button>
    <div class="mt-4 flex items-start gap-2 text-sm/5 text-muted"><IconShieldLock class="mt-0.5 size-4 shrink-0 stroke-muted"/><p>{t("auth.localStorageNotice")}</p></div>
  </section></main>;
}
