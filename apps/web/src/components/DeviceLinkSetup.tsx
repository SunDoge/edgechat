import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { IconCopy, IconDeviceMobile, IconRefresh, IconShieldCheck } from "@tabler/icons-solidjs";
import { deviceFingerprint, deviceLinkClaimBytes, OpenMlsMessagingCore, type DeviceIdentity, type WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { ApiClient, DeviceLinkStatus, SessionIdentity } from "@edgechat/sync";
import type { LocalDatabase } from "@edgechat/db";
import { renderSVG } from "uqr";
import { clearIdentity, loadIdentity, saveIdentity } from "../vault";
import { clearPendingDeviceLink, deviceLinkUrl, loadPendingDeviceLink, randomDeviceLinkToken, savePendingDeviceLink, sha256Base64Url, type PendingDeviceLink } from "../device-linking";
import { openDeviceHistory, openDeviceHistoryShard, type DeviceHistoryManifest } from "../device-history-transfer";
import { deviceHistoryStaging } from "../device-history-staging";
import { AttachmentCiphertextCache } from "../attachment-cache";
import { ArchiveSegmentCiphertextCache } from "../archive-segment-cache";
import { openDeviceHistoryBundle } from "../device-history-bundle";

type Stage = "preparing" | "waiting" | "approved" | "joining" | "error";

export function DeviceLinkSetup(props: {
  api: ApiClient;
  core: WebCryptoMessagingCore;
  db: LocalDatabase;
  onReady: (session: SessionIdentity, identity: DeviceIdentity, token: string, mls: OpenMlsMessagingCore, restoredHistory?: boolean) => void;
  onCancel: () => void;
}) {
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
  const attachmentCache = new AttachmentCiphertextCache();
  const archiveSegmentCache = new ArchiveSegmentCiphertextCache();

  const url = createMemo(() => pending() ? deviceLinkUrl(location.origin, pending()!.link_id, pending()!.secret) : "");
  const qr = createMemo(() => url() ? renderSVG(url(), { ecc: "M", border: 3, pixelSize: 5, blackColor: "#171717", whiteColor: "#ffffff" }) : "");

  async function persistMlsState() {
    if (!identity || !mls) return;
    identity = { ...identity, mlsState: mls.exportState() };
    await saveIdentity(identity);
  }

  async function begin(): Promise<void> {
    setStage("preparing"); setError("");
    let record = loadPendingDeviceLink();
    const stored = await loadIdentity();
    if (record && (!stored || stored.deviceId !== record.device_id)) { clearPendingDeviceLink(); record = null; }
    if (record && record.expires_at <= Date.now()) { clearPendingDeviceLink(); await clearIdentity(); record = null; }
    identity = record && stored ? stored : await props.core.createIdentity();
    mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
    const publicKeys = await props.core.exportPublicIdentity(identity);
    setFingerprint(await deviceFingerprint(publicKeys.signing_key, publicKeys.encryption_key));
    if (!record) {
      const packages = mls.generateKeyPackages(24);
      await persistMlsState();
      const result = await props.api.createDeviceLink({
        device_id: identity.deviceId,
        display_name: navigator.userAgent.includes("Mobile") ? "新手机" : "新浏览器",
        ...publicKeys,
        mls_key_packages: packages,
      });
      record = { version: 1, link_id: result.link_id, secret: result.secret, device_id: identity.deviceId, package_count: packages.length, expires_at: result.expires_at };
      savePendingDeviceLink(record);
    }
    setPending(record); setStage("waiting");
    await poll();
  }

  async function replenishPackages(current: PendingDeviceLink, required: number): Promise<PendingDeviceLink> {
    if (!mls || required <= current.package_count) return current;
    const packages = mls.generateKeyPackages(required - current.package_count + 8);
    await persistMlsState();
    const next = { ...current, package_count: current.package_count + packages.length };
    savePendingDeviceLink(next); setPending(next);
    await props.api.uploadDeviceLinkPackages(current.link_id, current.secret, packages);
    return next;
  }

  async function finishLink(current: PendingDeviceLink, nextStatus: DeviceLinkStatus): Promise<void> {
    if (!identity || !mls || !nextStatus.rooms) throw new Error("链接信息不完整，请在旧设备上重试");
    setStage("joining");
    for (const room of nextStatus.rooms) {
      if (!room.encrypted_state || mls.hasGroup(room.room_id)) continue;
      const packet = JSON.parse(room.encrypted_state) as { version: number; welcome: string; ratchet_tree: string };
      if (packet.version !== 1 || !packet.welcome || !packet.ratchet_tree) throw new Error("收到的对话加入凭证无效");
      mls.joinGroup(packet.welcome, packet.ratchet_tree);
      await persistMlsState();
    }
    let historySnapshot: Blob | null = null;
    if (nextStatus.history_transfer_ready && nextStatus.history_transfer) {
      const transfer = nextStatus.history_transfer;
      const manifest: DeviceHistoryManifest = { transfer_id: transfer.transfer_id, plaintext_bytes: transfer.plaintext_bytes,
        shard_plaintext_bytes: transfer.shard_plaintext_bytes, shard_count: transfer.shard_count };
      const ready = new Set(transfer.ready_shards); const acknowledged = new Set(transfer.acked_shards);
      const context = { linkId: current.link_id, sourceDeviceId: transfer.source_device_id, targetDeviceId: current.device_id };
      const plaintextParts: Blob[] = [];
      for (let index = 0; index < transfer.shard_count; index += 1) {
        let plaintext = await deviceHistoryStaging.targetPlaintextShard(current.link_id, index);
        if (!plaintext) {
          if (acknowledged.has(index)) throw new Error("本机已清除部分暂存历史，请重新发起设备链接");
          if (!ready.has(index)) throw new Error("设备历史分片尚未上传完整");
          const sealed = await props.api.downloadDeviceLinkHistoryShard(current.link_id, current.secret, index);
          plaintext = await openDeviceHistoryShard(sealed, manifest, index, context, identity);
          await deviceHistoryStaging.saveTargetPlaintextShard(current.link_id, index, plaintext);
          await props.api.acknowledgeDeviceLinkHistoryShard(current.link_id, current.secret, index);
        }
        plaintextParts.push(plaintext);
      }
      historySnapshot = new Blob(plaintextParts, { type: "application/gzip" });
      if (historySnapshot.size !== manifest.plaintext_bytes) throw new Error("设备历史快照不完整");
    } else if (nextStatus.history_transfer_ready) {
      if (!nextStatus.history_source_device_id) throw new Error("历史传输缺少来源设备信息");
      setStage("joining");
      const sealed = await props.api.downloadDeviceLinkHistory(current.link_id, current.secret);
      historySnapshot = await openDeviceHistory(sealed, {
        linkId: current.link_id, sourceDeviceId: nextStatus.history_source_device_id, targetDeviceId: current.device_id,
      }, identity);
    }
    const accessToken = current.access_token ?? randomDeviceLinkToken();
    const withToken = { ...current, access_token: accessToken }; savePendingDeviceLink(withToken); setPending(withToken);
    const tokenHash = await sha256Base64Url(accessToken);
    const signature = await props.core.sign(identity, deviceLinkClaimBytes(current.link_id, current.device_id, tokenHash));
    const session = await props.api.claimDeviceLink(current.link_id, current.secret, accessToken, signature);
    props.api.setToken(accessToken);
    if (historySnapshot) {
      const bundle = await openDeviceHistoryBundle(historySnapshot);
      await props.db.stageLinkedDeviceHistory(bundle.databaseSnapshot, session.user_id);
      for (const attachment of bundle.attachments) {
        const ciphertext = await attachment.ciphertext.arrayBuffer();
        if (!(await attachmentCache.put(attachment.id, ciphertext))) throw new Error("无法将附件历史保存到本机");
        const acknowledgement = await props.api.acknowledgeAttachmentRetention(attachment.id).catch(() => null);
        if (acknowledgement && acknowledgement.attachment_id !== attachment.id
          && !(await attachmentCache.put(acknowledgement.attachment_id, ciphertext))) {
          throw new Error("无法将附件历史保存到本机");
        }
      }
      for (const segment of bundle.segments) {
        const ciphertext = await segment.ciphertext.arrayBuffer();
        if (!(await archiveSegmentCache.put(segment.id, ciphertext))) throw new Error("无法将历史分段保存到本机");
        try { await props.api.acknowledgeArchiveSegmentRetention(segment.id); }
        catch (error) {
          // A 404 can mean the administrator intentionally GC'd the cloud copy.
          // Keep the device archive, but never use this path to resurrect it.
          if (!(error && typeof error === "object" && "status" in error && error.status === 404)) throw error;
        }
      }
      if (!nextStatus.history_transfer) await props.api.acknowledgeDeviceLinkHistory(current.link_id, current.secret);
      await deviceHistoryStaging.clearLink(current.link_id);
    }
    clearPendingDeviceLink(); handedOff = true;
    props.onReady(session, identity, accessToken, mls, Boolean(historySnapshot));
  }

  async function poll(): Promise<void> {
    const current = pending(); if (!current || stopped) return;
    try {
      const next = await props.api.deviceLinkStatus(current.link_id, current.secret); setStatus(next);
      if (next.status === "awaiting_packages") {
        await replenishPackages(current, next.required_packages); setStage("approved");
      } else if (next.status === "approved") setStage("approved");
      else if (next.status === "complete" || next.status === "claimed") return await finishLink(loadPendingDeviceLink() ?? current, next);
      else if (next.status === "cancelled") throw new Error("这个链接申请已取消");
      else setStage("waiting");
      timer = window.setTimeout(() => void poll(), 1_500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法继续链接设备"); setStage("error");
    }
  }

  async function retry() {
    setError(""); setStage(status()?.status === "approved" ? "approved" : "waiting");
    await poll();
  }

  async function cancel() {
    if (status()?.status && status()?.status !== "pending") return;
    window.clearTimeout(timer); clearPendingDeviceLink(); await clearIdentity(); props.onCancel();
  }

  onMount(() => void begin().catch((cause) => { setError(cause instanceof Error ? cause.message : "无法创建链接"); setStage("error"); }));
  onCleanup(() => { stopped = true; window.clearTimeout(timer); if (!handedOff) mls?.destroy(); });

  return <section class="grid gap-5">
    <div><h1 class="text-2xl font-semibold tracking-tight text-ink">链接这台设备</h1><p class="mt-2 text-sm/6 text-muted">在已经登录的设备中打开“设备与账户”，扫描这里的二维码。扫描后仍需在旧设备上确认。</p></div>
    <Show when={pending()} fallback={<div class="grid min-h-64 place-content-center justify-items-center gap-3 rounded-2xl bg-neutral-50"><span class="size-7 animate-pulse rounded-full bg-brand/20"/><p class="text-sm text-muted">正在创建独立设备密钥…</p></div>}>
      <div class="relative mx-auto grid w-full max-w-72 place-items-center overflow-hidden rounded-2xl bg-white p-5 shadow-[0_12px_40px_rgb(0_0_0/0.08)] ring-1 ring-black/8">
        <span class="pointer-events-none absolute left-3 top-3 size-5 border-l-2 border-t-2 border-brand"/><span class="pointer-events-none absolute right-3 top-3 size-5 border-r-2 border-t-2 border-brand"/><span class="pointer-events-none absolute bottom-3 left-3 size-5 border-b-2 border-l-2 border-brand"/><span class="pointer-events-none absolute bottom-3 right-3 size-5 border-b-2 border-r-2 border-brand"/>
        <div class="w-full [&_svg]:block [&_svg]:h-auto [&_svg]:w-full" role="img" aria-label="设备链接二维码" innerHTML={qr()}/>
      </div>
      <div class="rounded-xl bg-neutral-50 p-4 ring-1 ring-black/5"><div class="flex items-center gap-2"><IconShieldCheck class="size-4 stroke-brand"/><strong class="text-sm font-semibold text-ink">在两台设备上核对</strong></div><div class="mt-3 grid grid-cols-4 gap-2 font-mono text-xs font-semibold tracking-wide text-ink">{fingerprint().split(" ").map((part) => <span class="rounded-md bg-white px-1 py-2 text-center ring-1 ring-black/8">{part}</span>)}</div></div>
      <div class="flex gap-2"><button type="button" class="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg font-medium text-brand ring-1 ring-inset ring-brand/30 hover:bg-brand-soft" onClick={() => void navigator.clipboard.writeText(url()).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); })}><IconCopy class="size-4 stroke-brand"/>{copied() ? "已复制" : "复制链接"}</button></div>
    </Show>
    <div aria-live="polite" class={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm/5 ${stage() === "error" ? "bg-red-50 text-red-700" : "bg-brand-soft text-ink"}`}><IconDeviceMobile class={`mt-0.5 size-4 shrink-0 ${stage() === "error" ? "stroke-red-600" : "stroke-brand"}`}/><div><strong class="font-semibold">{stage() === "waiting" ? "等待旧设备确认" : stage() === "approved" ? "正在加入你的对话" : stage() === "joining" ? "正在恢复消息历史" : stage() === "error" ? "链接没有完成" : "正在准备"}</strong><p class="mt-0.5 text-xs/5 opacity-75">{stage() === "approved" ? `${status()?.room_count ?? status()?.rooms?.length ?? 0} 个对话将使用新的加密身份` : stage() === "error" ? error() : "保持此页面打开；历史只会以设备加密包短暂中转。"}</p></div></div>
    <Show when={stage() === "error"}><button type="button" class="flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white" onClick={() => void retry()}><IconRefresh class="size-4 stroke-white"/>继续尝试</button></Show>
    <Show when={stage() === "preparing" || stage() === "waiting" || (stage() === "error" && (!status()?.status || status()?.status === "pending"))}><button type="button" class="h-10 text-sm font-medium text-muted hover:text-ink" onClick={() => void cancel()}>取消并返回登录</button></Show>
  </section>;
}
