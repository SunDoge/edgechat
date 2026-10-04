import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { IconCopy, IconDeviceMobile, IconRefresh, IconShieldCheck } from "@tabler/icons-solidjs";
import { deviceFingerprint, deviceLinkClaimBytes, openAccountCredential, OpenMlsMessagingCore, type DeviceIdentity, type WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { ApiError, deviceHistoryTransferAvailable, type ApiClient, type DeviceLinkStatus, type SessionIdentity } from "@edgechat/sync";
import type { LocalDatabase } from "@edgechat/db";
import { renderSVG } from "uqr";
import { clearIdentity, loadIdentity, saveIdentity } from "../vault";
import { clearPendingDeviceLink, deviceLinkUrl, loadPendingDeviceLink, randomDeviceLinkToken, savePendingDeviceLink, sha256Base64Url, type PendingDeviceLink } from "../device-linking";
import { openDeviceHistoryShard, type DeviceHistoryManifest } from "../device-history-transfer";
import { deviceHistoryStagingFor } from "../device-history-staging";
import { deviceHistoryShardResumeAction } from "../device-link-target-policy";
import { AttachmentCiphertextCache } from "../attachment-cache";
import { ArchiveSegmentCiphertextCache } from "../archive-segment-cache";
import { openDeviceHistoryBundle } from "../device-history-bundle";
import { useI18n } from "../i18n";
import { operationErrorMessage, UserFacingError } from "../operation-errors";

type Stage = "preparing" | "waiting" | "approved" | "joining" | "cancelling" | "error";

export function DeviceLinkSetup(props: {
  profileId: string;
  api: ApiClient;
  core: WebCryptoMessagingCore;
  db: LocalDatabase;
  onReady: (session: SessionIdentity, identity: DeviceIdentity, token: string, mls: OpenMlsMessagingCore, restoredHistory?: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [stage, setStage] = createSignal<Stage>("preparing");
  const [pending, setPending] = createSignal<PendingDeviceLink | null>(null);
  const [fingerprint, setFingerprint] = createSignal("");
  const [error, setError] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [status, setStatus] = createSignal<DeviceLinkStatus | null>(null);
  let identity: DeviceIdentity | null = null;
  let mls: OpenMlsMessagingCore | null = null;
  let timer: number | undefined;
  let stopped = false;
  let handedOff = false;
  const attachmentCache = new AttachmentCiphertextCache(props.profileId);
  const archiveSegmentCache = new ArchiveSegmentCiphertextCache(props.profileId);
  const deviceHistoryStaging = deviceHistoryStagingFor(props.profileId);

  const url = createMemo(() => pending() ? deviceLinkUrl(location.origin, pending()!.link_id, pending()!.secret) : "");
  const qr = createMemo(() => url() ? renderSVG(url(), { ecc: "M", border: 3, pixelSize: 5, blackColor: "#171717", whiteColor: "#ffffff" }) : "");

  async function persistMlsState() {
    if (!identity || !mls) return;
    identity = { ...identity, mlsState: mls.exportState() };
    await saveIdentity(props.profileId, identity);
  }

  async function begin(): Promise<void> {
    setStage("preparing"); setError("");
    let record = loadPendingDeviceLink(props.profileId);
    const stored = await loadIdentity(props.profileId);
    if (record && (!stored || stored.deviceId !== record.device_id)) { clearPendingDeviceLink(props.profileId); record = null; }
    if (record && record.expires_at <= Date.now()) { clearPendingDeviceLink(props.profileId); await clearIdentity(props.profileId); record = null; }
    identity = record && stored ? stored : await props.core.createIdentity();
    mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
    const publicKeys = await props.core.exportPublicIdentity(identity);
    setFingerprint(await deviceFingerprint(publicKeys.signing_key, publicKeys.encryption_key));
    if (!record) {
      const packages = mls.generateKeyPackages(24);
      await persistMlsState();
      const result = await props.api.createDeviceLink({
        device_id: identity.deviceId,
        display_name: navigator.userAgent.includes("Mobile") ? t("deviceLink.device.mobile") : t("deviceLink.device.desktop"),
        ...publicKeys,
        mls_key_packages: packages,
      });
      record = { version: 1, link_id: result.link_id, secret: result.secret, device_id: identity.deviceId, package_count: packages.length, expires_at: result.expires_at };
      savePendingDeviceLink(props.profileId, record);
    }
    setPending(record); setStage("waiting");
    await poll();
  }

  async function replenishPackages(current: PendingDeviceLink, required: number): Promise<PendingDeviceLink> {
    if (!mls || required <= current.package_count) return current;
    const packages = mls.generateKeyPackages(required - current.package_count + 8);
    await persistMlsState();
    const next = { ...current, package_count: current.package_count + packages.length };
    savePendingDeviceLink(props.profileId, next); setPending(next);
    await props.api.uploadDeviceLinkPackages(current.link_id, current.secret, packages);
    return next;
  }

  async function finishLink(current: PendingDeviceLink, nextStatus: DeviceLinkStatus): Promise<void> {
    if (!identity || !mls || !nextStatus.rooms) throw UserFacingError.localized("deviceLink.error.incomplete");
    setStage("joining");
    if (nextStatus.account_mode === "opaque") {
      const transfer = nextStatus.account_credential;
      if (!transfer) throw UserFacingError.localized("deviceLink.error.accountCredentialMissing");
      const accountCredential = await openAccountCredential(transfer.envelope, {
        linkId: current.link_id, sourceDeviceId: transfer.source_device_id, targetDeviceId: current.device_id,
      }, identity);
      identity = { ...identity, accountCredential };
      await saveIdentity(props.profileId, identity);
    }
    for (const room of nextStatus.rooms) {
      if (!room.encrypted_state || mls.hasGroup(room.room_id)) continue;
      const packet = JSON.parse(room.encrypted_state) as { version: number; welcome: string; ratchet_tree: string };
      if (packet.version !== 1 || !packet.welcome || !packet.ratchet_tree) throw UserFacingError.localized("deviceLink.error.invalidWelcome");
      mls.joinGroup(packet.welcome, packet.ratchet_tree);
      await persistMlsState();
    }
    let historySnapshot: Blob | null = null;
    if (nextStatus.history_transfer) {
      const transfer = nextStatus.history_transfer;
      const manifest: DeviceHistoryManifest = { transfer_id: transfer.transfer_id, plaintext_bytes: transfer.plaintext_bytes,
        shard_plaintext_bytes: transfer.shard_plaintext_bytes, shard_count: transfer.shard_count };
      const ready = new Set(transfer.ready_shards); const acknowledged = new Set(transfer.acked_shards);
      const context = { linkId: current.link_id, sourceDeviceId: transfer.source_device_id, targetDeviceId: current.device_id };
      const plaintextParts: Blob[] = [];
      for (let index = 0; index < transfer.shard_count; index += 1) {
        let plaintext = await deviceHistoryStaging.targetPlaintextShard(current.link_id, index);
        const action = deviceHistoryShardResumeAction({
          ready: ready.has(index), acknowledged: acknowledged.has(index), hasLocalPlaintext: Boolean(plaintext),
        });
        if (action === "local_missing") throw UserFacingError.localized("deviceLink.error.localShardMissing");
        if (action === "remote_missing") throw UserFacingError.localized("deviceLink.error.remoteShardMissing");
        if (action === "download_and_acknowledge") {
          const sealed = await props.api.downloadDeviceLinkHistoryShard(current.link_id, current.secret, index);
          plaintext = await openDeviceHistoryShard(sealed, manifest, index, context, identity);
          await deviceHistoryStaging.saveTargetPlaintextShard(current.link_id, index, plaintext);
        }
        // The plaintext write may have succeeded immediately before an ACK
        // request/response was lost. Retrying this exact DELETE is idempotent
        // and performs no object GET; claim remains blocked until it lands.
        if (action === "download_and_acknowledge" || action === "acknowledge_local") {
          await props.api.acknowledgeDeviceLinkHistoryShard(current.link_id, current.secret, index);
        }
        if (!plaintext) throw UserFacingError.localized("deviceLink.error.incompleteHistory");
        plaintextParts.push(plaintext);
      }
      historySnapshot = new Blob(plaintextParts, { type: "application/gzip" });
      if (historySnapshot.size !== manifest.plaintext_bytes) throw UserFacingError.localized("deviceLink.error.incompleteHistory");
    }
    const accessToken = current.access_token ?? randomDeviceLinkToken();
    const deviceCredential = current.device_credential ?? randomDeviceLinkToken();
    const withToken = { ...current, access_token: accessToken, device_credential: deviceCredential };
    savePendingDeviceLink(props.profileId, withToken); setPending(withToken);
    const [tokenHash, deviceCredentialHash] = await Promise.all([sha256Base64Url(accessToken), sha256Base64Url(deviceCredential)]);
    const signature = await props.core.sign(identity,
      deviceLinkClaimBytes(current.link_id, current.device_id, tokenHash, deviceCredentialHash));
    const session = await props.api.claimDeviceLink(current.link_id, current.secret, accessToken, deviceCredential, signature);
    props.api.setToken(accessToken);
    if (historySnapshot) {
      const bundle = await openDeviceHistoryBundle(historySnapshot);
      await props.db.stageLinkedDeviceHistory(bundle.databaseSnapshot, session.user_id);
      for (const attachment of bundle.attachments) {
        const ciphertext = await attachment.ciphertext.arrayBuffer();
        if (!(await attachmentCache.put(attachment.id, ciphertext))) throw UserFacingError.localized("deviceLink.error.saveAttachment");
        const acknowledgement = await props.api.acknowledgeAttachmentRetention(attachment.id).catch(() => null);
        if (acknowledgement && acknowledgement.attachment_id !== attachment.id
          && !(await attachmentCache.put(acknowledgement.attachment_id, ciphertext))) {
          throw UserFacingError.localized("deviceLink.error.saveAttachment");
        }
      }
      for (const segment of bundle.segments) {
        const ciphertext = await segment.ciphertext.arrayBuffer();
        if (!(await archiveSegmentCache.put(segment.id, ciphertext))) throw UserFacingError.localized("deviceLink.error.saveSegment");
        try { await props.api.acknowledgeArchiveSegmentRetention(segment.id); }
        catch (error) {
          // A 404 can mean the administrator intentionally GC'd the cloud copy.
          // Keep the device archive, but never use this path to resurrect it.
          if (!(error && typeof error === "object" && "status" in error && error.status === 404)) throw error;
        }
      }
      await deviceHistoryStaging.clearLink(current.link_id);
    }
    identity = { ...identity, deviceCredential };
    await saveIdentity(props.profileId, identity);
    clearPendingDeviceLink(props.profileId); handedOff = true;
    props.onReady(session, identity, accessToken, mls, Boolean(historySnapshot));
  }

  async function poll(): Promise<void> {
    let current = pending(); if (!current || stopped) return;
    try {
      const next = await props.api.deviceLinkStatus(current.link_id, current.secret); setStatus(next);
      if (next.expires_at !== current.expires_at) {
        current = { ...current, expires_at: next.expires_at };
        savePendingDeviceLink(props.profileId, current); setPending(current);
      }
      if (next.status === "awaiting_packages") {
        await replenishPackages(current, next.required_packages); setStage("approved");
      } else if (next.status === "approved") setStage("approved");
      else if ((next.status === "complete" || next.status === "claimed") && next.account_mode === "opaque" && !next.account_credential_ready) setStage("approved");
      else if ((next.status === "complete" || next.status === "claimed") && next.history_transfer
        && !deviceHistoryTransferAvailable(next.history_transfer)) setStage("approved");
      else if (next.status === "complete" || next.status === "claimed") return await finishLink(loadPendingDeviceLink(props.profileId) ?? current, next);
      else if (next.status === "cancelled") throw UserFacingError.localized("deviceLink.error.cancelled");
      else setStage("waiting");
      timer = window.setTimeout(() => void poll(), 1_500);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "device_link_expired") {
        window.clearTimeout(timer);
        try {
          await deviceHistoryStaging.clearLink(current.link_id); await clearIdentity(props.profileId);
        } catch {
          setError(t("deviceLink.error.expiredCleanup")); setStage("error"); return;
        }
        clearPendingDeviceLink(props.profileId);
        mls?.destroy(); mls = null; identity = null; setPending(null); setStatus(null);
        setError(t("deviceLink.error.expired")); setStage("error"); return;
      }
      setError(operationErrorMessage(cause, t("deviceLink.error.continue"), t)); setStage("error");
    }
  }

  async function retry() {
    if (!pending()) return begin();
    setError(""); setStage(status()?.status === "approved" ? "approved" : "waiting");
    await poll();
  }

  async function cancel() {
    if (status()?.status && status()?.status !== "pending") return;
    const current = pending(); if (!current) return props.onCancel();
    window.clearTimeout(timer); setError(""); setStage("cancelling");
    try {
      await props.api.cancelDeviceLink(current.link_id, current.secret);
      await deviceHistoryStaging.clearLink(current.link_id); await clearIdentity(props.profileId);
      clearPendingDeviceLink(props.profileId); mls?.destroy(); mls = null; identity = null; setPending(null); props.onCancel();
    } catch (cause) {
      setError(operationErrorMessage(cause, t("deviceLink.error.cancel"), t)); setStage("error");
    }
  }

  onMount(() => void begin().catch((cause) => { setError(operationErrorMessage(cause, t("deviceLink.error.create"), t)); setStage("error"); }));
  onCleanup(() => { stopped = true; window.clearTimeout(timer); if (!handedOff) mls?.destroy(); });

  return <section class="grid gap-5">
    <div><h1 class="text-2xl font-semibold tracking-tight text-ink">{t("deviceLink.title")}</h1><p class="mt-2 text-sm/6 text-muted">{t("deviceLink.description")}</p></div>
    <Show when={pending()} fallback={<div class="grid min-h-64 place-content-center justify-items-center gap-3 rounded-2xl bg-neutral-50"><span class="size-7 animate-pulse rounded-full bg-brand/20"/><p class="text-sm text-muted">{t("deviceLink.preparingKeys")}</p></div>}>
      <div class="relative mx-auto grid w-full max-w-72 place-items-center overflow-hidden rounded-2xl bg-white p-5 shadow-[0_12px_40px_rgb(0_0_0/0.08)] ring-1 ring-black/8">
        <span class="pointer-events-none absolute left-3 top-3 size-5 border-l-2 border-t-2 border-brand"/><span class="pointer-events-none absolute right-3 top-3 size-5 border-r-2 border-t-2 border-brand"/><span class="pointer-events-none absolute bottom-3 left-3 size-5 border-b-2 border-l-2 border-brand"/><span class="pointer-events-none absolute bottom-3 right-3 size-5 border-b-2 border-r-2 border-brand"/>
        <div class="w-full [&_svg]:block [&_svg]:h-auto [&_svg]:w-full" role="img" aria-label={t("deviceLink.qrLabel")} innerHTML={qr()}/>
      </div>
      <div class="rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5"><div class="flex items-center gap-2"><IconShieldCheck class="size-4 stroke-brand"/><strong class="text-sm font-semibold text-ink">{t("deviceLink.compare")}</strong></div><div class="mt-3 grid grid-cols-4 gap-2 font-mono text-xs font-semibold tracking-wide text-ink">{fingerprint().split(" ").map((part) => <span class="rounded-md bg-white px-1 py-2 text-center ring-1 ring-black/8">{part}</span>)}</div></div>
      <div class="flex gap-2"><button type="button" class="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg font-medium text-brand ring-1 ring-inset ring-brand/30 hover:bg-brand-soft" onClick={() => void navigator.clipboard.writeText(url()).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); })}><IconCopy class="size-4 stroke-brand"/>{copied() ? t("deviceLink.copied") : t("deviceLink.copy")}</button></div>
    </Show>
    <div aria-live="polite" class={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm/5 ${stage() === "error" ? "bg-red-50 text-red-700" : "bg-brand-soft text-ink"}`}><IconDeviceMobile class={`mt-0.5 size-4 shrink-0 ${stage() === "error" ? "stroke-red-600" : "stroke-brand"}`}/><div><strong class="font-semibold">{stage() === "waiting" ? t("deviceLink.stage.waiting") : stage() === "approved" ? t("deviceLink.stage.approved") : stage() === "joining" ? t("deviceLink.stage.joining") : stage() === "cancelling" ? t("deviceLink.stage.cancelling") : stage() === "error" ? t("deviceLink.stage.error") : t("deviceLink.stage.preparing")}</strong><p class="mt-0.5 text-xs/5 opacity-75">{stage() === "approved" ? t("deviceLink.rooms", { count: status()?.room_count ?? status()?.rooms?.length ?? 0 }) : stage() === "error" ? error() : t("deviceLink.keepOpen")}</p></div></div>
    <Show when={stage() === "error"}><button type="button" class="flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white" onClick={() => void retry()}><IconRefresh class="size-4 stroke-white"/>{t("deviceLink.retry")}</button></Show>
    <Show when={stage() === "preparing" || stage() === "waiting" || (stage() === "error" && (!status()?.status || status()?.status === "pending"))}><button type="button" class="h-10 text-sm font-medium text-muted hover:text-ink" onClick={() => void cancel()}>{t("deviceLink.cancel")}</button></Show>
  </section>;
}
