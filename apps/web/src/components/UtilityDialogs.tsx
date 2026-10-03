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

export type DeviceRow = { device_id: string; display_name: string; signing_key: JsonWebKey; encryption_key: JsonWebKey; created_at: number; revoked_at: number | null };
export type DeviceRevocationProgress = { status: "working" | "failed"; completed: number; total: number; error?: string };

export type LocalSearchResult = SearchResult | ImageSearchResult;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function SearchDialog(props: { query: string; results: LocalSearchResult[]; coverageComplete: boolean; semanticStatus: "idle" | "loading" | "ready" | "error"; onQuery: (value: string) => void; onSelect: (roomId: RoomId, messageId: string) => void; onClose: () => void }) {
  return <Dialog id="message-search" title="搜索消息" description="文字与图片语义搜索都只在这台设备运行" onClose={props.onClose}>
    <div class="p-5"><label class="relative" for="message-search-input"><span class="sr-only">消息关键词</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="message-search-input" name="message_search" class="h-10 w-full rounded-lg pl-9 pr-3 ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand" value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} placeholder="搜索文字，或描述一张图片" autofocus/></label><p class="mt-3 text-xs text-muted">{props.semanticStatus === "loading" ? "正在本机准备图片模型…" : props.semanticStatus === "error" ? "图片语义索引暂不可用，文字搜索仍可使用" : props.coverageComplete ? "已搜索全部本地历史" : "更早的历史消息尚未建立索引"}</p><div class="mt-4 divide-y divide-black/5"><For each={props.results}>{(result) => <button type="button" class="w-full py-3 text-left" onClick={() => props.onSelect(result.room_id, result.message_id)}><Show when={result.kind === "image"} fallback={<p class="line-clamp-2 text-sm/5 text-ink">{(result as SearchResult).plaintext}</p>}><p class="flex items-center gap-2 text-sm/5 font-medium text-ink"><IconPhoto class="size-4 stroke-muted"/>{(result as ImageSearchResult).name}<span class="text-xs font-normal text-muted">相似度 {Math.round((result as ImageSearchResult).score * 100)}%</span></p></Show><small class="mt-1 block text-xs text-muted">{userName(result.sender)} · #{result.seq}</small></button>}</For></div></div>
  </Dialog>;
}

export function DevicesDialog(props: { devices: DeviceRow[]; revocations: Record<string, DeviceRevocationProgress>; profile: UserProfile | null; storage: StorageUsage | null; localStorageHealth: LocalStorageHealth | null; backup: LocalBackupExport | null; invitationPolicy: InvitationPolicy | null; installState: PwaInstallState; currentDeviceId: string; pushAvailable: boolean; pushStatus: PushStatus; voiceRecordingAvailable: boolean; passwordChangeSupported: boolean; linkPreviews: boolean; presenceSharing: boolean; exportBusy: boolean; onEditProfile: () => void; onInvitationPolicy: (policy: InvitationPolicy) => Promise<void>; onLinkPreviews: (enabled: boolean) => Promise<void>; onPresenceSharing: (enabled: boolean) => Promise<void>; onRequestPersistence: () => Promise<PersistenceRequestResult>; onInstall: () => void; onLinkDevice: () => void; onEnablePush: () => void; onDisablePush: () => void; onBackup: () => void; onChangePassword: () => void; onExport: () => void; onDeleteAccount: () => void; onRevoke: (deviceId: string) => void; onLogout: () => void; onClose: () => void }) {
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
    catch (cause) { setSelectedPolicy(props.invitationPolicy ?? "everyone"); setPrivacyError(cause instanceof Error ? cause.message : "无法保存邀请设置"); }
    finally { setPrivacyBusy(false); }
  }
  async function changeLinkPreviews() {
    setLinkBusy(true); setLinkError("");
    try { await props.onLinkPreviews(!props.linkPreviews); }
    catch (cause) { setLinkError(cause instanceof Error ? cause.message : "无法保存链接卡片设置"); }
    finally { setLinkBusy(false); }
  }
  async function changePresenceSharing() {
    setPresenceBusy(true); setPresenceError("");
    try { await props.onPresenceSharing(!props.presenceSharing); }
    catch (cause) { setPresenceError(cause instanceof Error ? cause.message : "无法保存在线状态设置"); }
    finally { setPresenceBusy(false); }
  }
  return <Dialog id="devices" title="设备与账户" description="每台设备拥有独立密钥" onClose={props.onClose} footer={<div class="grid gap-2 border-t border-black/5 p-5"><button type="button" class="flex h-10 items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10" onClick={props.onLinkDevice}><IconQrcode class="size-4 stroke-brand"/>链接新设备</button><Show when={props.pushAvailable && props.pushStatus !== "unsupported"}><button type="button" disabled={props.pushStatus === "repairing"} class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100 disabled:text-neutral-400" onClick={props.pushStatus === "on" ? props.onDisablePush : props.onEnablePush}><IconBell class="size-4 stroke-muted"/>{props.pushStatus === "repairing" ? "正在检查离线通知…" : props.pushStatus === "on" ? "关闭离线通知" : props.pushStatus === "blocked" ? "重新允许离线通知" : props.pushStatus === "error" ? "重试离线通知" : "开启离线通知"}</button></Show><Show when={props.passwordChangeSupported}><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100" onClick={props.onChangePassword}><IconKey class="size-4 stroke-muted"/>修改登录密码</button></Show><button type="button" disabled={props.exportBusy} class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100 disabled:text-neutral-400" onClick={props.onExport}><IconDownload class="size-4 stroke-muted"/>{props.exportBusy ? "正在整理数据…" : "导出账户数据清单"}</button><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-neutral-100" onClick={props.onLogout}><IconLogout class="size-4 stroke-muted"/>退出并移除本机密钥</button><button type="button" class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50" onClick={props.onDeleteAccount}><IconTrash class="size-4 stroke-red-500"/>删除账户</button></div>}>
    <Show when={props.profile}>{(profile) => <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><div class="min-w-0 flex-1"><strong class="block truncate text-base font-semibold text-ink">{profile().display_name}</strong><p class="mt-0.5 break-all text-xs text-muted">{profile().user_id}</p><Show when={profile().bio}><p class="mt-2 whitespace-pre-wrap break-words text-sm/5 text-ink">{profile().bio}</p></Show></div><button type="button" class="flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft" onClick={props.onEditProfile}><IconEdit class="size-4 stroke-brand"/>编辑</button></div></div>}</Show>
    <Show when={props.installState.status !== "unavailable"}><div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconDeviceMobileDown class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><strong class="text-sm font-medium text-ink">安装到这台设备</strong><Show when={props.installState.status === "installed"} fallback={<Show when={props.installState.status === "installing"} fallback={<p class="mt-1 text-xs/5 text-muted">{props.installState.status === "available" ? "安装后可从桌面或主屏幕直接打开。" : props.installState.platform === "ios" ? "点浏览器的分享按钮，再选择“添加到主屏幕”。" : "在浏览器菜单中选择“安装应用”或“添加到主屏幕”。"}</p>}><p class="mt-1 text-xs/5 text-muted" role="status">正在等待浏览器完成安装…</p></Show>}><p class="mt-1 flex items-center gap-2 text-xs/5 text-emerald-700"><span class="size-1.5 rounded-full bg-emerald-500"/>已作为应用打开</p></Show><Show when={props.installState.status === "available"}><button type="button" class="mt-3 min-h-10 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:brightness-95" onClick={props.onInstall}>安装 EdgeChat</button></Show></div></div></div></Show>
    <PwaCapabilityPanel pushConfigured={props.pushAvailable} pushStatus={props.pushStatus} voiceRecordingAvailable={props.voiceRecordingAvailable}/>
    <LocalStoragePanel health={props.localStorageHealth} onRequestPersistence={props.onRequestPersistence}/>
    <BackupHealthPanel backup={props.backup} onBackup={props.onBackup}/>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconCloudLock class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><div class="flex items-baseline justify-between gap-3"><strong class="text-sm font-medium text-ink">云端加密存储</strong><Show when={props.storage} fallback={<span class="text-xs text-muted">正在读取…</span>}>{(storage) => <span class="text-xs tabular-nums text-muted">{formatBytes(storage().used_bytes)} / {formatBytes(storage().quota_bytes)}</span>}</Show></div><Show when={props.storage}>{(storage) => { const ratio = () => Math.min(1, storage().used_bytes / storage().quota_bytes); return <><div class="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label="云端存储用量" aria-valuemin="0" aria-valuemax={storage().quota_bytes} aria-valuenow={storage().used_bytes}><div class={`h-full rounded-full ${ratio() >= 0.9 ? "bg-red-500" : ratio() >= 0.75 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${ratio() * 100}%` }}/></div><p class={`mt-2 text-xs/5 ${ratio() >= 0.9 ? "text-red-600" : "text-muted"}`}>{ratio() >= 0.9 ? "空间即将用尽，新的附件可能无法发送。" : `附件 ${formatBytes(storage().attachment_bytes)} · 消息历史 ${formatBytes(storage().archive_bytes)} · 头像 ${formatBytes(storage().avatar_bytes)}`}</p></>; }}</Show></div></div></div>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconShieldLock class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><label for="invitation-policy" class="block text-sm font-medium text-ink">谁可以联系我</label><p class="mt-1 text-xs/5 text-muted">陌生人只能发一条纯文本请求；群聊邀请仅限已有共同对话的人。</p><select id="invitation-policy" disabled={privacyBusy() || !props.invitationPolicy} class="mt-3 h-10 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" value={selectedPolicy()} onChange={(event) => void changePolicy(event.currentTarget.value as InvitationPolicy)}><option value="everyone">允许陌生人发送请求</option><option value="shared_rooms">仅有共同对话的人</option><option value="nobody">任何人都不可以</option></select><Show when={privacyBusy()}><p class="mt-2 text-xs text-muted" role="status">正在保存…</p></Show><Show when={privacyError()}><p class="mt-2 text-xs text-red-600" role="alert">{privacyError()}</p></Show></div></div></div>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconLink class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-4"><div><strong class="block text-sm font-medium text-ink">链接卡片</strong><p class="mt-1 text-xs/5 text-muted">只在本机显示域名和路径，不会预先联系网站，也不会上传网址或生成云端缩略图。</p></div><button type="button" role="switch" aria-label="显示链接卡片" aria-checked={props.linkPreviews} disabled={linkBusy()} class={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${props.linkPreviews ? "bg-brand" : "bg-neutral-300"}`} onClick={() => void changeLinkPreviews()}><span class={`absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform ${props.linkPreviews ? "left-6" : "left-1"}`}/></button></div><Show when={linkBusy()}><p class="mt-2 text-xs text-muted" role="status">正在保存…</p></Show><Show when={linkError()}><p class="mt-2 text-xs text-red-600" role="alert">{linkError()}</p></Show></div></div></div>
    <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconDeviceDesktop class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-4"><div><strong class="block text-sm font-medium text-ink">分享这台设备的在线状态</strong><p class="mt-1 text-xs/5 text-muted">默认关闭。开启后，共同对话成员会在本设备保持连接时看到“在线”；不会保存最后上线时间。</p></div><button type="button" role="switch" aria-label="分享这台设备的在线状态" aria-checked={props.presenceSharing} disabled={presenceBusy()} class={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${props.presenceSharing ? "bg-brand" : "bg-neutral-300"}`} onClick={() => void changePresenceSharing()}><span class={`absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform ${props.presenceSharing ? "left-6" : "left-1"}`}/></button></div><Show when={presenceBusy()}><p class="mt-2 text-xs text-muted" role="status">正在保存并重新连接…</p></Show><Show when={presenceError()}><p class="mt-2 text-xs text-red-600" role="alert">{presenceError()}</p></Show></div></div></div>
    <div class="divide-y divide-black/5 px-5"><For each={props.devices}>{(device) => { const progress = () => props.revocations[device.device_id]; return <div class="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-3"><IconDeviceDesktop class="size-4 shrink-0 stroke-muted"/><div class="min-w-0"><strong class="block truncate text-sm font-medium text-ink">{device.display_name}</strong><small class={`mt-1 block text-xs ${progress()?.status === "failed" ? "text-red-600" : "text-muted"}`}>{device.device_id === props.currentDeviceId ? "当前设备" : progress()?.status === "working" ? `正在安全移除 · ${progress().completed}/${progress().total} 个对话` : progress()?.status === "failed" ? `尚未完全移除 · ${progress().completed}/${progress().total} 个对话已完成` : device.revoked_at ? "已撤销" : new Date(device.created_at).toLocaleDateString("zh-CN")}</small><Show when={progress()?.error}><p class="mt-1 line-clamp-2 text-xs/4 text-red-600">{progress().error}</p></Show></div><Show when={!device.revoked_at && device.device_id !== props.currentDeviceId}><button type="button" disabled={progress()?.status === "working"} class="text-sm font-medium text-red-600 disabled:text-neutral-400" onClick={() => props.onRevoke(device.device_id)}>{progress()?.status === "working" ? "处理中" : progress()?.status === "failed" ? "重试" : "安全移除"}</button></Show><Show when={progress()?.status === "working"}><div class="col-start-2 col-end-4 mt-2 h-1 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label="安全移除设备进度" aria-valuemin="0" aria-valuemax={Math.max(1, progress().total)} aria-valuenow={progress().completed}><div class="h-full rounded-full bg-brand transition-[width]" style={{ width: `${progress().total ? progress().completed / progress().total * 100 : 100}%` }}/></div></Show><Show when={fingerprints()[device.device_id]}>{(fingerprint) => <details class="col-start-2 col-end-4 mt-2"><summary class="min-h-9 cursor-pointer py-2 text-xs font-semibold text-brand">查看验证字符</summary><DeviceFingerprint value={fingerprint()}/><p class="mt-2 text-xs/5 text-muted">对方核验你时，请通过另一个可信渠道逐组告知这些字符。</p></details>}</Show></div>; }}</For></div>
    <div class="border-t border-black/5 p-5"><button type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10" onClick={() => window.dispatchEvent(new Event("edgechat:manage-local-profiles"))}><IconSwitchHorizontal class="size-4 stroke-brand"/>切换或添加本机身份</button></div>
  </Dialog>;
}

export function BackupDialog(props: { onCreate: (password: string) => Promise<void>; onClose: () => void }) {
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
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建备份"); }
    finally { setBusy(false); }
  }
  return <Dialog id="portable-backup" title="创建加密本机备份" description="保存消息、搜索索引和这台设备的端到端加密状态" onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">任何获得文件和密码的人都能读取你的消息。请把两者分开保存。该文件用于恢复并替换这台设备，不要在两台设备上同时使用同一份身份。</div>
      <Input label="备份密码" id="backup-password" name="backup_password" type="password" minLength={12} autocomplete="new-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autofocus/>
      <Input label="再次输入密码" id="backup-confirmation" name="backup_confirmation" type="password" minLength={12} autocomplete="new-password" value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)}/>
      <p class="text-xs/5 text-muted">至少 12 个字符。文件只在浏览器中压缩和加密；服务器仅保存一个不含消息内容的防回滚检查点，不复制消息或附件。</p>
      <Show when={confirmation() && password() !== confirmation()}><p role="alert" class="text-sm text-red-600">两次输入的密码不一致</p></Show>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="mt-1 flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="submit" disabled={!valid() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? "正在加密…" : "保存备份"}</button></div>
    </form>
  </Dialog>;
}

export function AccountDeletionDialog(props: { onDelete: (password: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const confirmed = () => confirmation().trim() === "删除账户" && password().length > 0;
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!confirmed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onDelete(password()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "账户删除未能开始"); setBusy(false); }
  }
  return <Dialog id="delete-account" title="永久删除账户" description="先导出需要保留的数据；此操作无法撤销" onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div class="rounded-lg bg-red-50 px-3 py-3 text-sm/6 text-red-800">
        登录会立即停用，本机消息与密钥会被清除。私人对话的云端密文和附件将删除；共享对话会先由其他成员安全更新密钥，因此服务器清理可能稍后完成。已被收件人保存或导出的内容无法远程抹除。
      </div>
      <label class="grid gap-2 text-sm font-medium text-ink" for="delete-account-password">当前密码<input id="delete-account-password" name="password" type="password" autocomplete="current-password" class="h-11 rounded-lg px-3 text-base ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-red-500" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autofocus/></label>
      <label class="grid gap-2 text-sm font-medium text-ink" for="delete-account-confirmation">输入“删除账户”确认<input id="delete-account-confirmation" name="confirmation" class="h-11 rounded-lg px-3 text-base ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-red-500" value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)} autocomplete="off"/></label>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="mt-1 flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="submit" disabled={!confirmed() || busy()} class="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-neutral-300">{busy() ? "正在停用账户…" : "永久删除"}</button></div>
    </form>
  </Dialog>;
}
