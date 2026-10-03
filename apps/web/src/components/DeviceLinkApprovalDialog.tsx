import { Show, createSignal } from "solid-js";
import { IconDeviceMobile, IconLink, IconShieldCheck } from "@tabler/icons-solidjs";
import { deviceFingerprint } from "@edgechat/messaging-core";
import type { ApiClient, DeviceLinkPreview } from "@edgechat/sync";
import { parseDeviceLinkInput } from "../device-linking";
import { useI18n } from "../i18n";
import { DeviceFingerprint } from "./DeviceFingerprint";
import { Dialog } from "./primitives";
import { QrCameraScanner } from "./QrCameraScanner";
import { operationErrorMessage, UserFacingError } from "../operation-errors";

export function DeviceLinkApprovalDialog(props: { api: ApiClient; onApprove: (linkId: string) => Promise<void>; onCancelLink: (linkId: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [input, setInput] = createSignal("");
  const [preview, setPreview] = createSignal<DeviceLinkPreview | null>(null);
  const [fingerprint, setFingerprint] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [approvalStarted, setApprovalStarted] = createSignal(false);

  async function inspect(value = input()) {
    setBusy(true); setError(""); setConfirmed(false);
    try {
      const linkId = parseDeviceLinkInput(value);
      const next = await props.api.deviceLinkPreview(linkId);
      if (next.status === "complete" || next.status === "claimed" || next.status === "cancelled") throw new UserFacingError(t("deviceLinkApproval.error.ended"));
      setPreview(next); setFingerprint(await deviceFingerprint(next.signing_key, next.encryption_key));
    } catch (cause) { setError(operationErrorMessage(cause, t("deviceLinkApproval.error.read"), t)); }
    finally { setBusy(false); }
  }

  async function approve() {
    const item = preview(); if (!item || !confirmed() || busy()) return;
    setBusy(true); setError(""); setApprovalStarted(true);
    try { await props.onApprove(item.link_id); }
    catch (cause) { setError(operationErrorMessage(cause, t("deviceLinkApproval.error.approve"), t)); setBusy(false); }
  }

  async function cancelApproved() {
    const item = preview(); if (!item || busy()) return;
    setBusy(true); setError("");
    try { await props.onCancelLink(item.link_id); props.onClose(); }
    catch (cause) { setError(operationErrorMessage(cause, t("deviceLinkApproval.error.cancel"), t)); setBusy(false); }
  }

  return <Dialog id="approve-device-link" title={t("deviceLinkApproval.title")} description={preview() ? t("deviceLinkApproval.description.verify") : t("deviceLinkApproval.description.scan")} onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="grid gap-4 p-5">
      <Show when={!preview()} fallback={<>
        <div class="flex items-center gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5"><span class="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft"><IconDeviceMobile class="size-5 stroke-brand"/></span><div class="min-w-0"><strong class="block truncate text-sm font-semibold text-ink">{preview()!.display_name}</strong><p class="mt-0.5 text-xs text-muted">{t("deviceLinkApproval.request")}</p></div></div>
        <div class="rounded-xl border border-brand/20 bg-brand-soft/50 p-4"><div class="flex items-center gap-2"><IconShieldCheck class="size-4 stroke-brand"/><strong class="text-sm font-semibold text-ink">{t("deviceLinkApproval.compare")}</strong></div><DeviceFingerprint value={fingerprint()} class="mt-3 gap-2"/></div>
        <label class="flex items-start gap-3 rounded-xl p-3 text-sm/6 text-ink ring-1 ring-black/10"><input type="checkbox" class="mt-1 size-4 shrink-0 accent-brand" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)}/><span>{t("deviceLinkApproval.confirm")}</span></label>
        <div class="flex flex-wrap justify-end gap-2"><Show when={approvalStarted() && error()}><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-semibold text-red-600 hover:bg-red-50" onClick={() => void cancelApproved()}>{t("deviceLinkApproval.cancel")}</button></Show><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100" onClick={() => { setPreview(null); setConfirmed(false); setApprovalStarted(false); }}>{t("deviceLinkApproval.back")}</button><button type="button" disabled={!confirmed() || busy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:bg-neutral-300" onClick={() => void approve()}>{busy() ? t("deviceLinkApproval.approving") : t("deviceLinkApproval.approve")}</button></div>
      </>}>
        <QrCameraScanner autofocus scanLabel={t("deviceLinkApproval.scan")} stopLabel={t("deviceLinkApproval.stopScan")} unsupportedMessage={t("deviceLinkApproval.error.scanUnsupported")} cameraErrorMessage={t("deviceLinkApproval.error.camera")} onError={setError} onDetect={(value) => { setInput(value); return inspect(value); }}/>
        <div class="flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>{t("deviceLinkApproval.pasteDivider")}<span class="h-px flex-1 bg-black/10"/></div>
        <form class="grid gap-3" onSubmit={(event) => { event.preventDefault(); void inspect(); }}><label class="grid gap-2 text-sm font-medium text-ink" for="device-link-code">{t("deviceLinkApproval.link")}<input id="device-link-code" name="device_link" value={input()} onInput={(event) => setInput(event.currentTarget.value)} autocomplete="off" spellcheck={false} placeholder={t("deviceLinkApproval.placeholder")} class="h-11 min-w-0 rounded-lg px-3 text-base ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand"/></label><button type="submit" disabled={!input().trim() || busy()} class="flex h-11 items-center justify-center gap-2 rounded-lg bg-neutral-900 text-sm font-semibold text-white disabled:bg-neutral-300"><IconLink class="size-4 stroke-white"/>{busy() ? t("deviceLinkApproval.reading") : t("deviceLinkApproval.inspect")}</button></form>
      </Show>
      <Show when={error()}><p role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error()}</p></Show>
      <p class="text-xs/5 text-muted">{t("deviceLinkApproval.notice")}</p>
    </div>
  </Dialog>;
}
