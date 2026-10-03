import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { IconAlertTriangle, IconDeviceDesktop, IconShieldCheck } from "@tabler/icons-solidjs";
import { type LocalDatabase } from "@edgechat/db";
import { deviceFingerprint } from "@edgechat/messaging-core";
import type { RoomId } from "@edgechat/protocol";
import { type ApiClient, type ServerDevice } from "@edgechat/sync";
import { activeIdentityDevices, deviceTrustState, verificationKey, type DeviceTrustState } from "../device-verification";
import { useI18n } from "../i18n";
import { Dialog } from "./primitives";
import { DeviceFingerprint } from "./DeviceFingerprint";
import { operationErrorMessage } from "../operation-errors";

type FingerprintedDevice = ServerDevice & { fingerprint: string; trust: DeviceTrustState; verified_at: number | null };

export function IdentityVerificationDialog(props: { roomId: RoomId; userIds: string[]; displayNames: Record<string, string>; api: ApiClient; db: LocalDatabase; onClose: () => void }) {
  const { t } = useI18n();
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
    } catch (cause) { setError(operationErrorMessage(cause, t("identity.error.load"), t)); }
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
    } catch (cause) { setError(operationErrorMessage(cause, t("identity.error.save"), t)); }
    finally { setBusy(false); }
  }

  async function removeVerification(device: FingerprintedDevice) {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      await props.db.removeDeviceVerification(device.user_id, device.device_id);
      setDevices((current) => current.map((item) => item.device_id === device.device_id && item.user_id === device.user_id ? { ...item, trust: "unverified", verified_at: null } : item));
      setConfirmed(false);
    } catch (cause) { setError(operationErrorMessage(cause, t("identity.error.remove"), t)); }
    finally { setBusy(false); }
  }

  onMount(() => void load());

  return <Dialog id="identity-verification" title={t("identity.title")} description={t("identity.description")} onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="p-5">
      <p class="text-sm/6 text-muted">{t("identity.instructions")}</p>
      <Show when={loading()}><p class="py-10 text-center text-sm text-muted" role="status">{t("identity.loading")}</p></Show>
      <Show when={!loading() && !devices().length && !error()}><p class="py-10 text-center text-sm text-muted">{t("identity.empty")}</p></Show>
      <Show when={!loading() && devices().length}><div class="mt-4 divide-y divide-black/5 rounded-xl ring-1 ring-black/8"><For each={devices()}>{(device) => {
        const key = () => verificationKey(device.user_id, device.device_id);
        const active = () => selectedKey() === key();
        return <div class="p-3"><button type="button" aria-expanded={active()} class="flex min-h-11 w-full items-center gap-3 text-left" onClick={() => { setSelectedKey(active() ? null : key()); setConfirmed(false); }}>
          <IconDeviceDesktop class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-semibold text-ink">{props.displayNames[device.user_id] || device.user_id} · {device.display_name}</strong><small class="mt-0.5 block break-all text-xs/4 text-muted">{device.device_id}</small></span>
          <span class={`shrink-0 text-xs font-semibold ${device.trust === "verified" ? "text-emerald-700" : device.trust === "changed" ? "text-red-700" : "text-muted"}`}>{device.trust === "verified" ? t("identity.status.verified") : device.trust === "changed" ? t("identity.status.changed") : t("identity.status.unverified")}</span>
        </button><Show when={active()}><div class="mt-3 border-t border-black/5 pt-3">
          <Show when={device.trust === "changed"}><div class="mb-3 flex gap-2 rounded-lg bg-red-50 p-3 text-sm/5 text-red-800" role="alert"><IconAlertTriangle class="mt-0.5 size-4 shrink-0 stroke-red-600"/><span>{t("identity.changedWarning")}</span></div></Show>
          <DeviceFingerprint value={device.fingerprint}/>
          <Show when={device.trust === "verified"} fallback={<><label class="mt-3 flex min-h-11 items-start gap-3 rounded-lg bg-neutral-50 px-3 py-2.5 text-sm/5 text-ink"><input type="checkbox" class="mt-1 size-4 shrink-0 accent-brand" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)}/><span>{t("identity.confirm")}</span></label><button type="button" disabled={!confirmed() || busy()} class="mt-3 min-h-10 w-full rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300" onClick={() => void verify(device)}>{busy() ? t("identity.saving") : device.trust === "changed" ? t("identity.reverify") : t("identity.verify")}</button></>}><div class="mt-3 flex items-center justify-between gap-3"><span class="flex items-center gap-1.5 text-xs font-medium text-emerald-700"><IconShieldCheck class="size-4 stroke-emerald-600"/>{t("identity.verifiedHere")}</span><button type="button" disabled={busy()} class="min-h-10 rounded-lg px-3 text-xs font-semibold text-muted hover:bg-neutral-100 disabled:opacity-50" onClick={() => void removeVerification(device)}>{t("identity.remove")}</button></div></Show>
        </div></Show></div>;
      }}</For></div></Show>
      <Show when={error()}><div role="alert" class="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error()} <button type="button" class="ml-1 font-semibold underline" onClick={() => void load()}>{t("identity.retry")}</button></div></Show>
      <p class="mt-4 text-xs/5 text-muted">{t("identity.localOnly")}</p>
    </div>
  </Dialog>;
}
