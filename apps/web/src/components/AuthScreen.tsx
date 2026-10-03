import { Show, createSignal, onMount } from "solid-js";
import { IconQrcode, IconShieldLock, IconSwitchHorizontal, IconUpload } from "@tabler/icons-solidjs";
import { OpenMlsMessagingCore, type DeviceIdentity, type WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { deviceSessionProofBytes } from "@edgechat/protocol";
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { AccountAppealCategory, AccountAppealStatus, ApiClient, SessionIdentity } from "@edgechat/sync";
import type { LocalDatabase } from "@edgechat/db";
import { loadIdentity, saveIdentity } from "../vault";
import { authErrorMessage } from "../auth-errors";
import { Brand, Input } from "./primitives";
import { DeviceLinkSetup } from "./DeviceLinkSetup";
import { BackupRestoreForm } from "./BackupRestoreForm";
import { profileSessionKey } from "../local-profiles";
import { useI18n } from "../i18n";

export function AuthScreen(props: { profileId: string; accountHint?: string | null; api: ApiClient; core: WebCryptoMessagingCore; db: LocalDatabase; onReady: (session: SessionIdentity, identity: DeviceIdentity, token: string, mls: OpenMlsMessagingCore, restoredHistory?: boolean) => void; onRestoreBackup: (file: File, password: string, accountPassword: string) => Promise<void>; onManageProfiles: () => void }) {
  const { t } = useI18n();
  const restoreUserKey = profileSessionKey(props.profileId, "restore-user-id");
  const restoreCheckpointKey = profileSessionKey(props.profileId, "restore-checkpoint");
  const restorePhaseKey = profileSessionKey(props.profileId, "restore-phase");
  const appealReceiptKey = profileSessionKey(props.profileId, "account-appeal-receipt");
  const restoredUserHint = sessionStorage.getItem(restoreUserKey) ?? props.accountHint ?? "";
  const restoreCheckpoint = sessionStorage.getItem(restoreCheckpointKey) ?? "";
  const finishingRestore = Boolean(restoreCheckpoint);
  if (restoredUserHint) sessionStorage.removeItem(restoreUserKey);
  const [mode, setMode] = createSignal<"register" | "login" | "link">(restoredUserHint ? "login" : "register");
  const [username, setUsername] = createSignal(restoredUserHint);
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [deviceBusy, setDeviceBusy] = createSignal(false);
  const [passkeyBusy, setPasskeyBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  const [appealOpen, setAppealOpen] = createSignal(false);
  const [appealCategory, setAppealCategory] = createSignal<AccountAppealCategory>("login_locked");
  const [appealReceipt, setAppealReceipt] = createSignal(localStorage.getItem(appealReceiptKey) ?? "");
  const [appealStatus, setAppealStatus] = createSignal<AccountAppealStatus | null>(null);
  const [appealBusy, setAppealBusy] = createSignal(false);
  const [appealError, setAppealError] = createSignal("");
  const [deviceContinueAvailable, setDeviceContinueAvailable] = createSignal(false);
  const [localIdentityAvailable, setLocalIdentityAvailable] = createSignal(false);
  const [passkeysSupported, setPasskeysSupported] = createSignal(false);

  onMount(() => {
    setPasskeysSupported(browserSupportsWebAuthn());
    if (!restoredUserHint) return;
    void loadIdentity(props.profileId).then((identity) => {
      setLocalIdentityAvailable(Boolean(identity));
      setDeviceContinueAvailable(Boolean(identity?.deviceCredential));
    }).catch(() => undefined);
  });

  async function continueWithDevice() {
    if (busy() || deviceBusy()) return;
    setDeviceBusy(true); setError("");
    try {
      const identity = await loadIdentity(props.profileId);
      if (!identity?.deviceCredential || !identity.mlsState) throw new Error(t("auth.deviceContinue.error"));
      const { challenge } = await props.api.deviceSessionChallenge(identity.deviceId, identity.deviceCredential);
      if (challenge.device_id !== identity.deviceId) throw new Error(t("auth.deviceContinue.error"));
      const signature = await props.core.sign(identity, deviceSessionProofBytes(challenge));
      const result = await props.api.claimDeviceSession(challenge, identity.deviceCredential, signature);
      if (result.device_id !== identity.deviceId) throw new Error(t("auth.deviceContinue.error"));
      const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
      props.onReady(result, identity, result.access_token, mls);
    } catch {
      setDeviceContinueAvailable(false);
      setError(t("auth.deviceContinue.error"));
    } finally { setDeviceBusy(false); }
  }

  async function prepareDevice(requireExisting = false) {
    const existing = await loadIdentity(props.profileId);
    if (requireExisting && !existing) throw new Error(t("auth.passkey.deviceLinkRequired"));
    const identity = existing ?? await props.core.createIdentity();
    const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
    const publicKeys = await props.core.exportPublicIdentity(identity);
    const stored = { ...identity, mlsState: mls.exportState() };
    const device = {
      device_id: identity.deviceId, display_name: navigator.userAgent.includes("Mobile") ? t("auth.device.mobile") : t("auth.device.desktop"),
      ...publicKeys, mls_key_packages: mls.generateKeyPackages(12),
      ...(restoreCheckpoint ? { backup_checkpoint: restoreCheckpoint } : {}),
      ...(identity.deviceCredential ? { device_credential: identity.deviceCredential } : {}),
    };
    await saveIdentity(props.profileId, stored);
    return { stored, mls, device };
  }

  async function continueWithPasskey() {
    if (busy() || deviceBusy() || passkeyBusy() || !username()) return;
    setPasskeyBusy(true); setError("");
    try {
      // Keep the options fetch directly inside the click turn for Safari's
      // user-activation rules; device/MLS preparation happens after assertion.
      const pending = await props.api.passkeyAuthenticationOptions(username());
      const assertion = await startAuthentication({ optionsJSON: pending.options as unknown as PublicKeyCredentialRequestOptionsJSON });
      const { stored, mls, device } = await prepareDevice(true);
      if ("backup_checkpoint" in device) throw new Error(t("auth.passkey.backupPasswordRequired"));
      const result = await props.api.loginWithPasskey({
        user_id: username(), challenge_id: pending.challenge_id, challenge: pending.challenge,
        response: assertion, device,
      });
      const authenticatedIdentity = result.device_credential ? { ...stored, deviceCredential: result.device_credential } : stored;
      if (authenticatedIdentity !== stored) await saveIdentity(props.profileId, authenticatedIdentity);
      props.onReady(result, authenticatedIdentity, result.access_token, mls);
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== "NotAllowedError" ? authErrorMessage(cause, t) : t("auth.passkey.cancelled"));
    } finally { setPasskeyBusy(false); }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { stored, mls, device } = await prepareDevice();
      const result = mode() === "register"
        ? await props.api.register({ localpart: username(), password: password(), device })
        : await props.api.login({ user_id: username(), password: password(), device });
      const authenticatedIdentity = result.device_credential ? { ...stored, deviceCredential: result.device_credential } : stored;
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
    <Show when={mode() === "login" && deviceContinueAvailable() && !finishingRestore}><div class="mb-5 grid gap-3">
      <button type="button" class="h-11 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:bg-neutral-300" disabled={busy() || deviceBusy()} onClick={() => void continueWithDevice()}>{deviceBusy() ? t("auth.deviceContinue.loading") : t("auth.deviceContinue.action")}</button>
      <p class="text-xs/5 text-muted">{t("auth.deviceContinue.description")}</p>
      <Show when={!passkeysSupported()}><div class="flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>{t("auth.deviceContinue.passwordFallback")}<span class="h-px flex-1 bg-black/10"/></div></Show>
    </div></Show>
    <Show when={mode() === "login" && passkeysSupported() && localIdentityAvailable() && !finishingRestore}><div class="mb-5 grid gap-3">
      <button type="button" class={`${deviceContinueAvailable() ? "bg-white text-brand ring-1 ring-inset ring-brand/30 hover:bg-brand-soft" : "bg-brand text-white hover:bg-brand-strong"} h-11 rounded-lg px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:bg-neutral-100 disabled:text-neutral-400`} disabled={!username() || busy() || deviceBusy() || passkeyBusy()} onClick={() => void continueWithPasskey()}>{passkeyBusy() ? t("auth.passkey.loading") : t("auth.passkey.action")}</button>
      <p class="text-xs/5 text-muted">{t("auth.passkey.description")}</p>
      <div class="flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>{t("auth.deviceContinue.passwordFallback")}<span class="h-px flex-1 bg-black/10"/></div>
    </div></Show>
    <form class="grid gap-5" onSubmit={submit}>
      <div class="grid gap-1.5">
        <Input label={mode() === "register" ? t("auth.accountName") : t("auth.accountIdentifier")} id="username" name="username" value={username()} onInput={(event) => setUsername(event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_.@:-]/g, ""))} placeholder={mode() === "register" ? "alice" : "alice 或 @alice:example.com"} autocomplete={mode() === "login" ? "username webauthn" : "username"} aria-describedby={mode() === "register" ? "account-name-help" : undefined} required autofocus={!restoredUserHint}/>
        <Show when={mode() === "register"}><p id="account-name-help" class="text-xs/5 text-muted">{t("auth.accountNameHint")}</p></Show>
      </div>
      <div class="grid gap-1.5">
        <Input label={t("auth.loginPassword")} id="password" name="password" type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} minLength={10} autocomplete={mode() === "register" ? "new-password" : "current-password"} aria-describedby="login-password-help" required autofocus={Boolean(restoredUserHint)}/>
        <p id="login-password-help" class="text-xs/5 text-muted">{t("auth.loginPasswordHint")}</p>
      </div>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error()}</div></Show>
      <button type="submit" class="h-11 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:bg-neutral-300" disabled={busy() || deviceBusy() || passkeyBusy()}>{busy() ? t("auth.submit.loading") : mode() === "register" ? t("auth.register.action") : t("common.login")}</button>
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
