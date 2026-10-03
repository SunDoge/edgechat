import { For, Show, createEffect, createSignal } from "solid-js";
import { IconBell, IconCloudLock, IconDeviceDesktop, IconDeviceMobileDown, IconDownload, IconEdit, IconKey, IconLink, IconLogout, IconPhoto, IconQrcode, IconSearch, IconShieldLock, IconSwitchHorizontal, IconTrash } from "@tabler/icons-solidjs";
import type { ImageSearchResult, SearchResult } from "@edgechat/db";
import { deviceFingerprint } from "@edgechat/messaging-core";
import type { RoomId, UserProfile } from "@edgechat/protocol";
import type { InvitationPolicy, StorageUsage } from "@edgechat/sync";
import { userName } from "../presenters";
import type { PwaInstallState } from "../pwa-install";
import type { PushStatus } from "../push-subscription";
import type { LocalStorageHealth, PersistenceRequestResult } from "../local-storage-health";
import type { LocalBackupExport } from "../local-profiles";
import { Dialog, Input } from "./primitives";
import { BackupHealthPanel } from "./BackupHealthPanel";
import { DeviceFingerprint } from "./DeviceFingerprint";
import { LocalStoragePanel } from "./LocalStoragePanel";
import { PwaCapabilityPanel } from "./PwaCapabilityPanel";
import { useI18n } from "../i18n";

export type DeviceRow = { device_id: string; display_name: string; signing_key: JsonWebKey; encryption_key: JsonWebKey; created_at: number; revoked_at: number | null };
export type DeviceRevocationProgress = { status: "working" | "failed"; completed: number; total: number; error?: string };

export type LocalSearchResult = SearchResult | ImageSearchResult;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function SearchDialog(props: { query: string; results: LocalSearchResult[]; coverageComplete: boolean; semanticEnabled: boolean; semanticStatus: "idle" | "loading" | "ready" | "error"; onEnableSemantic: () => void; onDisableSemantic: () => Promise<void>; onQuery: (value: string) => void; onSelect: (roomId: RoomId, messageId: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [semanticDisableBusy, setSemanticDisableBusy] = createSignal(false);
  async function disableSemantic(): Promise<void> {
    if (semanticDisableBusy()) return;
    setSemanticDisableBusy(true);
    try { await props.onDisableSemantic(); }
    finally { setSemanticDisableBusy(false); }
  }
  return <Dialog id="message-search" title={t("search.title")} description={props.semanticEnabled ? t("search.description.semantic") : t("search.description.text")} onClose={props.onClose}>
    <div class="p-5"><label class="relative" for="message-search-input"><span class="sr-only">{t("search.keyword")}</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="message-search-input" name="message_search" class="h-10 w-full rounded-lg pl-9 pr-3 ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand" value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} placeholder={props.semanticEnabled ? t("search.placeholder.semantic") : t("search.placeholder.text")} autofocus/></label>
      <Show when={props.semanticEnabled} fallback={<div class="mt-3 flex items-start justify-between gap-3 rounded-lg bg-neutral-50 p-3 ring-1 ring-black/5"><div class="min-w-0"><strong class="block text-sm font-medium text-ink">{t("search.semantic.offTitle")}</strong><p class="mt-1 text-xs/5 text-muted">{t("search.semantic.offDescription")}</p></div><button type="button" class="min-h-10 shrink-0 rounded-lg bg-white px-3 text-sm font-semibold text-brand ring-1 ring-brand/25 hover:bg-brand-soft" onClick={props.onEnableSemantic}>{t("search.semantic.enable")}</button></div>}>
        <div class="mt-3 flex items-start justify-between gap-3"><p class="min-w-0 text-xs/5 text-muted">{props.semanticStatus === "loading" ? t("search.semantic.loading") : props.semanticStatus === "error" ? t("search.semantic.error") : props.coverageComplete ? t("search.coverage.complete") : t("search.coverage.incomplete")}</p><button type="button" disabled={semanticDisableBusy()} class="shrink-0 text-xs font-semibold text-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50" onClick={() => void disableSemantic()}>{semanticDisableBusy() ? t("search.semantic.clearing") : t("search.semantic.disable")}</button></div>
        <p class="mt-1 text-[11px]/4 text-muted">{t("search.semantic.storageNotice")}</p>
      </Show>
      <Show when={!props.semanticEnabled}><p class="mt-3 text-xs text-muted">{props.coverageComplete ? t("search.textCoverage.complete") : t("search.textCoverage.incomplete")}</p></Show>
      <div class="mt-4 divide-y divide-black/5"><For each={props.results}>{(result) => <button type="button" class="w-full py-3 text-left" onClick={() => props.onSelect(result.room_id, result.message_id)}><Show when={result.kind === "image"} fallback={<p class="line-clamp-2 text-sm/5 text-ink">{(result as SearchResult).plaintext}</p>}><p class="flex items-center gap-2 text-sm/5 font-medium text-ink"><IconPhoto class="size-4 stroke-muted"/>{(result as ImageSearchResult).name}<span class="text-xs font-normal text-muted">{t("search.similarity", { score: Math.round((result as ImageSearchResult).score * 100) })}</span></p></Show><small class="mt-1 block text-xs text-muted">{userName(result.sender)} · #{result.seq}</small></button>}</For></div></div>
  </Dialog>;
}

export function DevicesDialog(props: { devices: DeviceRow[]; revocations: Record<string, DeviceRevocationProgress>; profile: UserProfile | null; storage: StorageUsage | null; localStorageHealth: LocalStorageHealth | null; backup: LocalBackupExport | null; invitationPolicy: InvitationPolicy | null; installState: PwaInstallState; currentDeviceId: string; pushAvailable: boolean; pushStatus: PushStatus; voiceRecordingAvailable: boolean; passwordChangeSupported: boolean; passkeysSupported: boolean; linkPreviews: boolean; presenceSharing: boolean; exportBusy: boolean; onEditProfile: () => void; onInvitationPolicy: (policy: InvitationPolicy) => Promise<void>; onLinkPreviews: (enabled: boolean) => Promise<void>; onPresenceSharing: (enabled: boolean) => Promise<void>; onRequestPersistence: () => Promise<PersistenceRequestResult>; onInstall: () => void; onLinkDevice: () => void; onEnablePush: () => void; onDisablePush: () => void; onBackup: () => void; onChangePassword: () => void; onManagePasskeys: () => void; onExport: () => void; onDeleteAccount: () => void; onRevoke: (deviceId: string) => void; onLogout: () => void; onClose: () => void }) {
  const { locale, t } = useI18n();
  const [privacyBusy, setPrivacyBusy] = createSignal(false); const [privacyError, setPrivacyError] = createSignal(""); const [linkBusy, setLinkBusy] = createSignal(false); const [linkError, setLinkError] = createSignal(""); const [presenceBusy, setPresenceBusy] = createSignal(false); const [presenceError, setPresenceError] = createSignal("");
  const [selectedPolicy, setSelectedPolicy] = createSignal<InvitationPolicy>("everyone");
  const [fingerprints, setFingerprints] = createSignal<Record<string, string>>({});
  let fingerprintRevision = 0;
  createEffect(() => { if (props.invitationPolicy) setSelectedPolicy(props.invitationPolicy); });
  createEffect(() => {
    const revision = ++fingerprintRevision; const current = props.devices;
    void Promise.all(current.map(async (device) => [device.device_id, await deviceFingerprint(device.signing_key, device.encryption_key)] as const))
      .then((values) => { if (revision === fingerprintRevision) setFingerprints(Object.fromEntries(values)); })
      .catch(() => { if (revision === fingerprintRevision) setFingerprints({}); });
  });
  async function changePolicy(policy: InvitationPolicy) {
    setSelectedPolicy(policy); setPrivacyBusy(true); setPrivacyError("");
    try { await props.onInvitationPolicy(policy); }
    catch (cause) { setSelectedPolicy(props.invitationPolicy ?? "everyone"); setPrivacyError(cause instanceof Error ? cause.message : t("devices.error.invitationPolicy")); }
    finally { setPrivacyBusy(false); }
  }
  async function changeLinkPreviews() {
    setLinkBusy(true); setLinkError("");
    try { await props.onLinkPreviews(!props.linkPreviews); }
    catch (cause) { setLinkError(cause instanceof Error ? cause.message : t("devices.error.linkPreviews")); }
    finally { setLinkBusy(false); }
  }
  async function changePresenceSharing() {
    setPresenceBusy(true); setPresenceError("");
    try { await props.onPresenceSharing(!props.presenceSharing); }
    catch (cause) { setPresenceError(cause instanceof Error ? cause.message : t("devices.error.presence")); }
    finally { setPresenceBusy(false); }
  }
  return <Dialog id="devices" title={t("devices.title")} description={t("devices.description")} onClose={props.onClose} footer={<div class="grid gap-2 border-t border-black/5 p-5"><button type="button" class="flex h-10 items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10" onClick={props.onLinkDevice}><IconQrcode class="size-4 stroke-brand"/>{t("devices.link")}</button><Show when={props.pushAvailable && props.pushStatus !== "unsupported"}><button type="button" disabled={props.pushStatus === "repairing"} class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100 disabled:text-neutral-400" onClick={props.pushStatus === "on" ? props.onDisablePush : props.onEnablePush}><IconBell class="size-4 stroke-muted"/>{props.pushStatus === "repairing" ? t("devices.push.repairing") : props.pushStatus === "on" ? t("devices.push.disable") : props.pushStatus === "blocked" ? t("devices.push.allowAgain") : props.pushStatus === "error" ? t("devices.push.retry") : t("devices.push.enable")}</button></Show><Show when={props.passkeysSupported}><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100" onClick={props.onManagePasskeys}><IconShieldLock class="size-4 stroke-muted"/>{t("devices.passkeys.manage")}</button></Show><Show when={props.passwordChangeSupported}><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100" onClick={props.onChangePassword}><IconKey class="size-4 stroke-muted"/>{t("devices.password.change")}</button></Show><button type="button" disabled={props.exportBusy} class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100 disabled:text-neutral-400" onClick={props.onExport}><IconDownload class="size-4 stroke-muted"/>{props.exportBusy ? t("devices.export.preparing") : t("devices.export.action")}</button><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100" onClick={props.onLogout}><IconLogout class="size-4 stroke-muted"/>{t("devices.logout")}</button><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50" onClick={props.onDeleteAccount}><IconTrash class="size-4 stroke-red-500"/>{t("devices.deleteAccount")}</button></div>}>
    <Show when={props.profile}>{(profile) => <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><div class="min-w-0 flex-1"><strong class="block truncate text-base font-semibold text-ink">{profile().display_name}</strong><p class="mt-0.5 break-all text-xs text-muted">{profile().user_id}</p><Show when={profile().bio}><p class="mt-2 whitespace-pre-wrap break-words text-sm/5 text-ink">{profile().bio}</p></Show></div><button type="button" class="flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft" onClick={props.onEditProfile}><IconEdit class="size-4 stroke-brand"/>{t("devices.profile.edit")}</button></div></div>}</Show>
    <Show when={props.installState.status !== "unavailable"}><div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconDeviceMobileDown class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><strong class="text-sm font-medium text-ink">{t("devices.install.title")}</strong><Show when={props.installState.status === "installed"} fallback={<Show when={props.installState.status === "installing"} fallback={<p class="mt-1 text-xs/5 text-muted">{props.installState.status === "available" ? t("devices.install.available") : props.installState.platform === "ios" ? t("devices.install.ios") : t("devices.install.browser")}</p>}><p class="mt-1 text-xs/5 text-muted" role="status">{t("devices.install.installing")}</p></Show>}><p class="mt-1 flex items-center gap-2 text-xs/5 text-emerald-700"><span class="size-1.5 rounded-full bg-emerald-500"/>{t("devices.install.installed")}</p></Show><Show when={props.installState.status === "available"}><button type="button" class="mt-3 min-h-10 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:brightness-95" onClick={props.onInstall}>{t("devices.install.action")}</button></Show></div></div></div></Show>
    <PwaCapabilityPanel pushConfigured={props.pushAvailable} pushStatus={props.pushStatus} voiceRecordingAvailable={props.voiceRecordingAvailable}/>
    <LocalStoragePanel health={props.localStorageHealth} onRequestPersistence={props.onRequestPersistence}/>
    <BackupHealthPanel backup={props.backup} onBackup={props.onBackup}/>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconCloudLock class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><div class="flex items-baseline justify-between gap-3"><strong class="text-sm font-medium text-ink">{t("devices.storage.title")}</strong><Show when={props.storage} fallback={<span class="text-xs text-muted">{t("devices.storage.loading")}</span>}>{(storage) => <span class="text-xs tabular-nums text-muted">{formatBytes(storage().used_bytes)} / {formatBytes(storage().quota_bytes)}</span>}</Show></div><Show when={props.storage}>{(storage) => { const ratio = () => Math.min(1, storage().used_bytes / storage().quota_bytes); return <><div class="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label={t("devices.storage.aria")} aria-valuemin="0" aria-valuemax={storage().quota_bytes} aria-valuenow={storage().used_bytes}><div class={`h-full rounded-full ${ratio() >= 0.9 ? "bg-red-500" : ratio() >= 0.75 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${ratio() * 100}%` }}/></div><p class={`mt-2 text-xs/5 ${ratio() >= 0.9 ? "text-red-600" : "text-muted"}`}>{ratio() >= 0.9 ? t("devices.storage.warning") : t("devices.storage.breakdown", { attachments: formatBytes(storage().attachment_bytes), archives: formatBytes(storage().archive_bytes), avatars: formatBytes(storage().avatar_bytes) })}</p></>; }}</Show></div></div></div>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconShieldLock class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><label for="invitation-policy" class="block text-sm font-medium text-ink">{t("devices.privacy.title")}</label><p class="mt-1 text-xs/5 text-muted">{t("devices.privacy.description")}</p><select id="invitation-policy" disabled={privacyBusy() || !props.invitationPolicy} class="mt-3 h-10 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" value={selectedPolicy()} onChange={(event) => void changePolicy(event.currentTarget.value as InvitationPolicy)}><option value="everyone">{t("devices.privacy.everyone")}</option><option value="shared_rooms">{t("devices.privacy.sharedRooms")}</option><option value="nobody">{t("devices.privacy.nobody")}</option></select><Show when={privacyBusy()}><p class="mt-2 text-xs text-muted" role="status">{t("devices.saving")}</p></Show><Show when={privacyError()}><p class="mt-2 text-xs text-red-600" role="alert">{privacyError()}</p></Show></div></div></div>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconLink class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-4"><div><strong class="block text-sm font-medium text-ink">{t("devices.linkPreviews.title")}</strong><p class="mt-1 text-xs/5 text-muted">{t("devices.linkPreviews.description")}</p></div><button type="button" role="switch" aria-label={t("devices.linkPreviews.aria")} aria-checked={props.linkPreviews} disabled={linkBusy()} class={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${props.linkPreviews ? "bg-brand" : "bg-neutral-300"}`} onClick={() => void changeLinkPreviews()}><span class={`absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform ${props.linkPreviews ? "left-6" : "left-1"}`}/></button></div><Show when={linkBusy()}><p class="mt-2 text-xs text-muted" role="status">{t("devices.saving")}</p></Show><Show when={linkError()}><p class="mt-2 text-xs text-red-600" role="alert">{linkError()}</p></Show></div></div></div>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconDeviceDesktop class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-4"><div><strong class="block text-sm font-medium text-ink">{t("devices.presence.title")}</strong><p class="mt-1 text-xs/5 text-muted">{t("devices.presence.description")}</p></div><button type="button" role="switch" aria-label={t("devices.presence.title")} aria-checked={props.presenceSharing} disabled={presenceBusy()} class={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${props.presenceSharing ? "bg-brand" : "bg-neutral-300"}`} onClick={() => void changePresenceSharing()}><span class={`absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform ${props.presenceSharing ? "left-6" : "left-1"}`}/></button></div><Show when={presenceBusy()}><p class="mt-2 text-xs text-muted" role="status">{t("devices.presence.saving")}</p></Show><Show when={presenceError()}><p class="mt-2 text-xs text-red-600" role="alert">{presenceError()}</p></Show></div></div></div>
    <div class="divide-y divide-black/5 px-5"><For each={props.devices}>{(device) => { const progress = () => props.revocations[device.device_id]; return <div class="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-3"><IconDeviceDesktop class="size-4 shrink-0 stroke-muted"/><div class="min-w-0"><strong class="block truncate text-sm font-medium text-ink">{device.display_name}</strong><small class={`mt-1 block text-xs ${progress()?.status === "failed" ? "text-red-600" : "text-muted"}`}>{device.device_id === props.currentDeviceId ? t("devices.current") : progress()?.status === "working" ? t("devices.revocation.working", { completed: progress().completed, total: progress().total }) : progress()?.status === "failed" ? t("devices.revocation.failed", { completed: progress().completed, total: progress().total }) : device.revoked_at ? t("devices.revoked") : new Date(device.created_at).toLocaleDateString(locale())}</small><Show when={progress()?.error}><p class="mt-1 line-clamp-2 text-xs/4 text-red-600">{progress().error}</p></Show></div><Show when={!device.revoked_at && device.device_id !== props.currentDeviceId}><button type="button" disabled={progress()?.status === "working"} class="text-sm font-medium text-red-600 disabled:text-neutral-400" onClick={() => props.onRevoke(device.device_id)}>{progress()?.status === "working" ? t("devices.revocation.processing") : progress()?.status === "failed" ? t("devices.revocation.retry") : t("devices.revocation.action")}</button></Show><Show when={progress()?.status === "working"}><div class="col-start-2 col-end-4 mt-2 h-1 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label={t("devices.revocation.progress")} aria-valuemin="0" aria-valuemax={Math.max(1, progress().total)} aria-valuenow={progress().completed}><div class="h-full rounded-full bg-brand transition-[width]" style={{ width: `${progress().total ? progress().completed / progress().total * 100 : 100}%` }}/></div></Show><Show when={fingerprints()[device.device_id]}>{(fingerprint) => <details class="col-start-2 col-end-4 mt-2"><summary class="min-h-9 cursor-pointer py-2 text-xs font-semibold text-brand">{t("devices.fingerprint.show")}</summary><DeviceFingerprint value={fingerprint()}/><p class="mt-2 text-xs/5 text-muted">{t("devices.fingerprint.description")}</p></details>}</Show></div>; }}</For></div>
    <div class="border-t border-black/5 p-5"><button type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10" onClick={() => window.dispatchEvent(new Event("edgechat:manage-local-profiles"))}><IconSwitchHorizontal class="size-4 stroke-brand"/>{t("devices.profiles.manage")}</button></div>
  </Dialog>;
}

export function BackupDialog(props: { onCreate: (password: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const valid = () => password().length >= 12 && password() === confirmation();
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid() || busy()) return;
    setBusy(true); setError("");
    try { await props.onCreate(password()); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("backup.create.error")); }
    finally { setBusy(false); }
  }
  return <Dialog id="portable-backup" title={t("backup.create.title")} description={t("backup.create.description")} onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">{t("backup.create.warning")}</div>
      <Input label={t("backup.create.password")} id="backup-password" name="backup_password" type="password" minLength={12} autocomplete="new-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autofocus/>
      <Input label={t("backup.create.confirmPassword")} id="backup-confirmation" name="backup_confirmation" type="password" minLength={12} autocomplete="new-password" value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)}/>
      <p class="text-xs/5 text-muted">{t("backup.create.storageNotice")}</p>
      <Show when={confirmation() && password() !== confirmation()}><p role="alert" class="text-sm text-red-600">{t("backup.create.mismatch")}</p></Show>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="mt-1 flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>{t("common.cancel")}</button><button type="submit" disabled={!valid() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? t("backup.create.encrypting") : t("backup.create.action")}</button></div>
    </form>
  </Dialog>;
}

export function AccountDeletionDialog(props: { accountCredential?: string; onDelete: (password: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const reauthenticationCredential = () => props.accountCredential ?? password();
  const confirmed = () => confirmation().trim() === t("accountDelete.confirmationText") && reauthenticationCredential().length > 0;
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!confirmed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onDelete(reauthenticationCredential()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("accountDelete.error")); setBusy(false); }
  }
  return <Dialog id="delete-account" title={t("accountDelete.title")} description={t("accountDelete.description")} onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div class="rounded-lg bg-red-50 px-3 py-3 text-sm/6 text-red-800">
        {t("accountDelete.warning")}
      </div>
      <Show when={!props.accountCredential} fallback={<p class="rounded-lg bg-neutral-50 px-3 py-2.5 text-xs/5 text-muted">{t("accountDelete.deviceConfirmation")}</p>}><label class="grid gap-2 text-sm font-medium text-ink" for="delete-account-password">{t("accountDelete.password")}<input id="delete-account-password" name="password" type="password" autocomplete="current-password" class="h-11 rounded-lg px-3 text-base ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-red-500" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autofocus/></label></Show>
      <label class="grid gap-2 text-sm font-medium text-ink" for="delete-account-confirmation">{t("accountDelete.confirmation")}<input id="delete-account-confirmation" name="confirmation" class="h-11 rounded-lg px-3 text-base ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-red-500" value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)} autocomplete="off" autofocus={Boolean(props.accountCredential)}/></label>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="mt-1 flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>{t("common.cancel")}</button><button type="submit" disabled={!confirmed() || busy()} class="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-neutral-300">{busy() ? t("accountDelete.deleting") : t("accountDelete.action")}</button></div>
    </form>
  </Dialog>;
}
