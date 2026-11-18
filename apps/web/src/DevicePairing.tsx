import { useMemo, useState } from "react";
import { renderSVG } from "uqr";
import {
  deviceFingerprint, deviceLinkClaimBytes, encodeBase64Url, openAccountCredential,
  OpenMlsMessagingCore, type WebCryptoMessagingCore,
} from "@edgechat/messaging-core";
import { loadIdentity, saveIdentity } from "@edgechat/client-storage/vault";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import { ApiError, deviceHistoryTransferAvailable, type ApiClient, type DeviceLinkPreview } from "@edgechat/sync";
import { LocalDatabase } from "@edgechat/db";
import { ArchiveSegmentCiphertextCache } from "@edgechat/client-runtime/archive-segment-cache";
import { AttachmentCiphertextCache } from "@edgechat/client-runtime/attachment-cache";
import { createDeviceHistoryBundle, openDeviceHistoryBundle } from "./device-history-bundle";
import { deviceHistoryStagingFor } from "./device-history-staging";
import { createDeviceHistoryManifest, openDeviceHistoryShard, sealDeviceHistoryShard, type DeviceHistoryManifest } from "./device-history-transfer";
import type { AuthResult } from "./auth-model";
import { ActionButton, TextInput } from "./ui";
import { devicePairingUrl } from "./device-pairing-link";

type Request = { link_id: string; secret: string; deviceId: string; token: string; credential: string; pairingCode?: string };
const SHORT_CODE = /^[2-9A-HJ-NP-Z]{8}$/;
const FULL_CODE = /^[A-Za-z0-9_-]{16,96}$/;
const normalizeShortCode = (value: string) => value.trim().toUpperCase().replace(/[\s-]/g, "");
const randomToken = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const tokenHash = async (value: string) => encodeBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

export function DevicePairing({ profileId, api, core, onReady, onBack }: {
  profileId: string; api: ApiClient; core: WebCryptoMessagingCore;
  onReady(result: AuthResult): Promise<void>; onBack(): void;
}) {
  const key = `edgechat.react-link.${profileId}`;
  const [request, setRequest] = useState<Request | null>(() => {
    const saved = localStorage.getItem(key);
    try { return saved ? JSON.parse(saved) as Request : null; } catch { return null; }
  });
  const [fingerprint, setFingerprint] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const code = request?.pairingCode ? request.pairingCode.replace(/^(.{4})(.{4})$/, "$1-$2") : request?.link_id;
  const pairingUrl = request ? devicePairingUrl(location.origin, request.link_id) : null;
  const qrImage = useMemo(() => pairingUrl
    ? `data:image/svg+xml,${encodeURIComponent(renderSVG(pairingUrl, { ecc: "M", border: 4, pixelSize: 5 }))}`
    : null, [pairingUrl]);

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("已复制编号。");
    } catch {
      setCopyStatus("请选中下方编号并手动复制。");
    }
  }

  async function run(action: "advance" | "cancel") {
    setBusy(true); setError("");
    let mls: OpenMlsMessagingCore | undefined;
    const staging = deviceHistoryStagingFor(profileId);
    try {
      if (action === "cancel" && request) {
        await api.cancelDeviceLink(request.link_id, request.secret);
        await staging.clearLink(request.link_id).catch(() => undefined);
        localStorage.removeItem(key);
        setRequest(null); setFingerprint(""); setStatus("");
        return;
      }
      let identity = await loadIdentity(profileId);
      if (!request && (identity?.deviceCredential || identity?.accountCredential)) throw new Error("profile already enrolled");
      if (!request) identity = await core.createIdentity();
      if (!identity) throw new Error("missing device identity");
      if (request && identity.deviceId !== request.deviceId) throw new Error("device changed");
      mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
      const keys = await core.exportPublicIdentity(identity);
      setFingerprint(await deviceFingerprint(keys.signing_key, keys.encryption_key));
      const persist = async () => {
        if (!identity || !mls) throw new Error("missing device state");
        identity = { ...identity, mlsState: mls.exportState() };
        await saveIdentity(profileId, identity);
      };
      if (!request) {
        const packages = mls.generateKeyPackages(24);
        await persist();
        const response = await api.createDeviceLink({
          device_id: identity.deviceId, display_name: navigator.userAgent.includes("Mobile") ? "移动设备" : "浏览器",
          ...keys, mls_key_packages: packages,
        });
        const next = { link_id: response.link_id, secret: response.secret, deviceId: identity.deviceId, token: randomToken(), credential: randomToken(), pairingCode: response.pairing_code };
        localStorage.setItem(key, JSON.stringify(next));
        setRequest(next); setStatus("请在旧设备上批准此请求。");
        return;
      }
      const remote = await api.deviceLinkStatus(request.link_id, request.secret);
      if (remote.status === "cancelled" || (remote.status !== "claimed" && remote.expires_at <= Date.now())) {
        await staging.clearLink(request.link_id).catch(() => undefined);
        localStorage.removeItem(key); setRequest(null); setStatus("配对请求已失效，请重新创建。"); return;
      }
      if (remote.status === "awaiting_packages") {
        const packages = mls.generateKeyPackages(Math.min(remote.required_packages, 24));
        await persist();
        await api.uploadDeviceLinkPackages(request.link_id, request.secret, packages);
        setStatus("已提交设备密钥，请回旧设备继续批准。"); return;
      }
      if (!["complete", "claimed"].includes(remote.status) || (remote.account_mode === "opaque" && !remote.account_credential)) {
        setStatus("旧设备尚未完成批准，请稍后再检查。"); return;
      }
      if (remote.history_transfer && !deviceHistoryTransferAvailable(remote.history_transfer)) {
        setStatus("旧设备正在上传加密历史，请稍后再检查。"); return;
      }
      if (remote.account_credential) {
        const transfer = remote.account_credential;
        identity.accountCredential = await openAccountCredential(transfer.envelope, {
          linkId: request.link_id, sourceDeviceId: transfer.source_device_id, targetDeviceId: request.deviceId,
        }, identity);
      }
      if (!remote.rooms) throw new Error("missing linked rooms");
      for (const room of remote.rooms) {
        if (mls.hasGroup(room.room_id)) continue;
        const welcome = JSON.parse(room.encrypted_state ?? "null");
        if (welcome?.version !== 1 || typeof welcome.welcome !== "string" || typeof welcome.ratchet_tree !== "string") throw new Error("invalid room welcome");
        mls.joinGroup(welcome.welcome, welcome.ratchet_tree);
      }
      await persist();
      const transfer = remote.history_transfer;
      let history: Awaited<ReturnType<typeof openDeviceHistoryBundle>> | undefined;
      if (transfer) {
        setStatus("正在接收加密历史，请保持页面打开。");
        const parts: Blob[] = [];
        const acknowledged = new Set(transfer.acked_shards);
        for (let index = 0; index < transfer.shard_count; index++) {
          let part = await staging.targetPlaintextShard(request.link_id, index);
          if (!part) {
            if (acknowledged.has(index)) throw new Error("staged history missing");
            const sealed = await api.downloadDeviceLinkHistoryShard(request.link_id, request.secret, index);
            part = await openDeviceHistoryShard(sealed, transfer, index, {
              linkId: request.link_id, sourceDeviceId: transfer.source_device_id, targetDeviceId: request.deviceId,
            }, identity);
            await staging.saveTargetPlaintextShard(request.link_id, index, part);
          }
          if (!acknowledged.has(index)) await api.acknowledgeDeviceLinkHistoryShard(request.link_id, request.secret, index);
          parts.push(part);
        }
        history = await openDeviceHistoryBundle(new Blob(parts));
      }
      const signature = await core.sign(identity, deviceLinkClaimBytes(request.link_id, request.deviceId, await tokenHash(request.token), await tokenHash(request.credential)));
      const session = await api.claimDeviceLink(request.link_id, request.secret, request.token, request.credential, signature);
      if (history) {
        const database = new LocalDatabase(profileId);
        try {
          await database.open();
          await database.stageLinkedDeviceHistory(history.databaseSnapshot, session.user_id);
        } finally { database.close(); }
        const attachments = new AttachmentCiphertextCache(profileId);
        const segments = new ArchiveSegmentCiphertextCache(profileId);
        for (const { id, ciphertext } of history.attachments) {
          if (!await attachments.put(id, await ciphertext.arrayBuffer())) throw new Error("cannot store attachment");
        }
        for (const { id, ciphertext } of history.segments) {
          if (!await segments.put(id, await ciphertext.arrayBuffer())) throw new Error("cannot store archive segment");
        }
      }
      identity.deviceCredential = request.credential;
      await persist();
      const ready = onReady({ session, identity, token: request.token, mls });
      mls = undefined;
      await ready;
      localStorage.removeItem(key);
      await staging.clearLink(request.link_id).catch(() => undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 410) {
        if (request) await staging.clearLink(request.link_id).catch(() => undefined);
        localStorage.removeItem(key); setRequest(null); setFingerprint(""); setStatus("配对请求已失效，请重新创建。");
      } else {
        setError(action === "cancel" ? "无法取消配对，请稍后重试。" : "无法继续配对。请确认网络正常，并使用未登录的新浏览器。");
      }
    } finally { mls?.destroy(); setBusy(false); }
  }

  return <section className="grid min-w-0 gap-4">
    <h1 className="text-2xl font-semibold text-ink">添加这台设备</h1>
    <p className="text-sm text-muted">用已登录的旧设备扫描二维码并批准。也可以复制编号，粘贴到旧设备的「设置 → 账户设备」。</p>
    {request && <div className="grid gap-2 text-sm">
      {qrImage && <img src={qrImage} alt="设备配对二维码" width="184" height="184" className="mx-auto rounded-xl border border-line" />}
      <div className="rounded-xl bg-neutral-50 p-3">
        <p>{request.pairingCode ? "手输配对码（5 分钟内有效）" : "配对编号"}</p>
        <code className="mt-1 block select-all break-all text-lg font-semibold tracking-wider">{code}</code>
        <ActionButton variant="quiet" onPress={() => void copyCode()}>复制配对码</ActionButton>
        {copyStatus && <p role="status" className="text-muted">{copyStatus}</p>}
      </div>
      {fingerprint && <><p>设备指纹</p><code className="break-words rounded bg-neutral-100 p-2">{fingerprint}</code></>}
    </div>}
    {status && <p role="status" className="text-sm text-muted">{status}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <ActionButton isDisabled={busy} onPress={() => void run("advance")}>{busy ? "请稍候…" : request ? "检查配对进度" : "生成配对二维码"}</ActionButton>
    {request && <ActionButton variant="quiet" isDisabled={busy} onPress={() => void run("cancel")}>取消配对</ActionButton>}
    <ActionButton variant="quiet" isDisabled={busy} onPress={onBack}>返回</ActionButton>
  </section>;
}

export function ApproveDevicePairing({ runtime, initialCode, onComplete }: { runtime: BrowserMessagingRuntime; initialCode: string; onComplete(): Promise<void> }) {
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<DeviceLinkPreview | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const shortCode = normalizeShortCode(code);
  const isShort = SHORT_CODE.test(shortCode);

  async function proceed() {
    setBusy(true); setError(""); setStatus("");
    try {
      if (!preview) {
        const next = isShort ? await runtime.api.deviceLinkPreviewByCode(shortCode) : await runtime.api.deviceLinkPreview(code.trim());
        setFingerprint(await deviceFingerprint(next.signing_key, next.encryption_key));
        setPreview(next);
      } else if (await runtime.approveLinkedDevice(preview.link_id, preview.device_id, async (view, identity, segments) => {
        if (deviceHistoryTransferAvailable(view.history_transfer)) return;
        const staging = deviceHistoryStagingFor(runtime.profileId);
        const linkId = view.link_id;
        let snapshot = await staging.sourceSnapshot(linkId);
        let manifest = await staging.sourceManifest<DeviceHistoryManifest>(linkId);
        if (!snapshot || !manifest) {
          if (view.history_transfer) throw new Error("history source missing");
          snapshot = await createDeviceHistoryBundle(await runtime.db.backupSnapshot(), await new AttachmentCiphertextCache(runtime.profileId).entries().catch(() => []), segments);
          manifest = createDeviceHistoryManifest(snapshot.size);
          await staging.saveSourceSnapshot(linkId, snapshot);
          await staging.saveSourceManifest(linkId, manifest);
        }
        const { transfer } = await runtime.api.createDeviceLinkHistoryTransfer(linkId, manifest);
        const uploaded = new Set([...transfer.ready_shards, ...transfer.acked_shards]);
        for (let index = 0; index < manifest.shard_count; index++) {
          if (uploaded.has(index)) continue;
          const sealed = await sealDeviceHistoryShard(snapshot, manifest, index, {
            linkId, sourceDeviceId: identity.deviceId, targetDeviceId: view.device_id,
          }, identity, view.encryption_key);
          await runtime.api.uploadDeviceLinkHistoryShard(linkId, index, sealed);
        }
        await staging.clearLink(linkId);
      })) {
        setPreview(null); setCode(""); setStatus("设备已批准。请回到新设备，点击「检查配对进度」。");
        await onComplete();
      } else {
        setStatus("请先在新设备检查配对进度，再回这里继续批准。");
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404 && isShort && !preview) {
        setError("配对码无效、已过期或已使用。请核对配对码，或扫描新设备的二维码。");
      } else {
        setError("无法处理配对请求。请核对配对码，或等待本机同步后重试。");
      }
    } finally { setBusy(false); }
  }

  return <div className="mt-4 grid gap-2">
    <TextInput label="新设备配对码" value={code} onChange={(value) => { setCode(value); setPreview(null); setStatus(""); setError(""); }} isDisabled={busy} inputProps={{ autoComplete: "off", spellCheck: false, maxLength: 96, placeholder: "7KMP-3XQT" }} />
    {preview && <p className="break-words text-sm text-muted">请核对新设备指纹：<code className="block">{fingerprint}</code></p>}
    {status && <p role="status" className="text-sm text-muted">{status}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <ActionButton isDisabled={busy || (!isShort && !FULL_CODE.test(code.trim()))} onPress={() => void proceed()}>{busy ? "请稍候…" : preview ? "指纹一致，批准设备" : "查看配对请求"}</ActionButton>
  </div>;
}
