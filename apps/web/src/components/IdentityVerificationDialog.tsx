import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { IconAlertTriangle, IconDeviceDesktop, IconShieldCheck } from "@tabler/icons-solidjs";
import { type LocalDatabase } from "@edgechat/db";
import { deviceFingerprint } from "@edgechat/messaging-core";
import type { RoomId } from "@edgechat/protocol";
import { type ApiClient, type ServerDevice } from "@edgechat/sync";
import { activeIdentityDevices, deviceTrustState, verificationKey, type DeviceTrustState } from "../device-verification";
import { Dialog } from "./primitives";
import { DeviceFingerprint } from "./DeviceFingerprint";

type FingerprintedDevice = ServerDevice & { fingerprint: string; trust: DeviceTrustState; verified_at: number | null };

export function IdentityVerificationDialog(props: { roomId: RoomId; userIds: string[]; displayNames: Record<string, string>; api: ApiClient; db: LocalDatabase; onClose: () => void }) {
  const [devices, setDevices] = createSignal<FingerprintedDevice[]>([]);
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [confirmed, setConfirmed] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const selected = createMemo(() => devices().find((device) => verificationKey(device.user_id, device.device_id) === selectedKey()) ?? null);

  async function load() {
    setLoading(true); setError("");
    try {
      const userIds = [...new Set(props.userIds)];
      const [response, records] = await Promise.all([
        props.api.roomDevices(props.roomId),
        props.db.deviceVerifications(userIds),
      ]);
      const verificationByDevice = new Map(records.map((record) => [verificationKey(record.user_id, record.device_id), record]));
      const members = new Set(userIds);
      const active = activeIdentityDevices(response.devices).filter((device) => members.has(device.user_id));
      const next = await Promise.all(active.map(async (device): Promise<FingerprintedDevice> => {
        const fingerprint = await deviceFingerprint(device.signing_key, device.encryption_key);
        const record = verificationByDevice.get(verificationKey(device.user_id, device.device_id));
        return { ...device, fingerprint, trust: deviceTrustState(record, fingerprint), verified_at: record?.verified_at ?? null };
      }));
      next.sort((left, right) => left.user_id.localeCompare(right.user_id) || left.created_at - right.created_at || left.device_id.localeCompare(right.device_id));
      setDevices(next);
      if (selectedKey() && !next.some((device) => verificationKey(device.user_id, device.device_id) === selectedKey())) setSelectedKey(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取成员设备"); }
    finally { setLoading(false); }
  }

  async function verify(device: FingerprintedDevice) {
    if (!confirmed() || busy()) return;
    setBusy(true); setError("");
    try {
      const verifiedAt = Date.now();
      await props.db.verifyDevice(device.user_id, device.device_id, device.fingerprint, verifiedAt);
      setDevices((current) => current.map((item) => item.device_id === device.device_id && item.user_id === device.user_id ? { ...item, trust: "verified", verified_at: verifiedAt } : item));
      setConfirmed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存本机验证状态"); }
    finally { setBusy(false); }
  }

  async function removeVerification(device: FingerprintedDevice) {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      await props.db.removeDeviceVerification(device.user_id, device.device_id);
      setDevices((current) => current.map((item) => item.device_id === device.device_id && item.user_id === device.user_id ? { ...item, trust: "unverified", verified_at: null } : item));
      setConfirmed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法移除本机验证状态"); }
    finally { setBusy(false); }
  }

  onMount(() => void load());

  return <Dialog id="identity-verification" title="核验加密身份" description="通过电话或面对面逐台核对设备" onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="p-5">
      <p class="text-sm/6 text-muted">验证字符来自设备公开密钥。请让对方在自己的“设备与账户”中打开同一台设备，并逐组核对；不要只相信此页面本身。</p>
      <Show when={loading()}><p class="py-10 text-center text-sm text-muted" role="status">正在读取成员设备…</p></Show>
      <Show when={!loading() && !devices().length && !error()}><p class="py-10 text-center text-sm text-muted">没有可核验的活动设备</p></Show>
      <Show when={!loading() && devices().length}><div class="mt-4 divide-y divide-black/5 rounded-xl ring-1 ring-black/8"><For each={devices()}>{(device) => {
        const key = () => verificationKey(device.user_id, device.device_id);
        const active = () => selectedKey() === key();
        return <div class="p-3"><button type="button" aria-expanded={active()} class="flex min-h-11 w-full items-center gap-3 text-left" onClick={() => { setSelectedKey(active() ? null : key()); setConfirmed(false); }}>
          <IconDeviceDesktop class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-semibold text-ink">{props.displayNames[device.user_id] || device.user_id} · {device.display_name}</strong><small class="mt-0.5 block break-all text-xs/4 text-muted">{device.device_id}</small></span>
          <span class={`shrink-0 text-xs font-semibold ${device.trust === "verified" ? "text-emerald-700" : device.trust === "changed" ? "text-red-700" : "text-muted"}`}>{device.trust === "verified" ? "已验证" : device.trust === "changed" ? "密钥已变化" : "未验证"}</span>
        </button><Show when={active()}><div class="mt-3 border-t border-black/5 pt-3">
          <Show when={device.trust === "changed"}><div class="mb-3 flex gap-2 rounded-lg bg-red-50 p-3 text-sm/5 text-red-800" role="alert"><IconAlertTriangle class="mt-0.5 size-4 shrink-0 stroke-red-600"/><span>这台设备当前的密钥与之前验证的不一致。确认原因前，不要把对话当作已核验。</span></div></Show>
          <DeviceFingerprint value={device.fingerprint}/>
          <Show when={device.trust === "verified"} fallback={<><label class="mt-3 flex min-h-11 items-start gap-3 rounded-lg bg-neutral-50 px-3 py-2.5 text-sm/5 text-ink"><input type="checkbox" class="mt-1 size-4 shrink-0 accent-brand" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)}/><span>我已通过另一个可信渠道与对方核对全部验证字符</span></label><button type="button" disabled={!confirmed() || busy()} class="mt-3 min-h-10 w-full rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300" onClick={() => void verify(device)}>{busy() ? "正在保存…" : device.trust === "changed" ? "重新标记为已验证" : "标记为已验证"}</button></>}><div class="mt-3 flex items-center justify-between gap-3"><span class="flex items-center gap-1.5 text-xs font-medium text-emerald-700"><IconShieldCheck class="size-4 stroke-emerald-600"/>已在这台设备上核对</span><button type="button" disabled={busy()} class="min-h-10 rounded-lg px-3 text-xs font-semibold text-muted hover:bg-neutral-100 disabled:opacity-50" onClick={() => void removeVerification(device)}>撤销本机验证</button></div></Show>
        </div></Show></div>;
      }}</For></div></Show>
      <Show when={error()}><div role="alert" class="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error()} <button type="button" class="ml-1 font-semibold underline" onClick={() => void load()}>重试</button></div></Show>
      <p class="mt-4 text-xs/5 text-muted">验证结果只保存在你的本机数据库和你主动创建的加密设备迁移/备份中；服务器不会知道你核验了谁。</p>
    </div>
  </Dialog>;
}
