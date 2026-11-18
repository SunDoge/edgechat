import { lazy, Suspense, useEffect, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { IconBell, IconDeviceLaptop, IconInfoCircle, IconShieldLock, IconX } from "@tabler/icons-react";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import type { PushStatus } from "@edgechat/client-runtime/push-subscription";
import type { ServerDevice } from "@edgechat/sync";
import { supportsVoiceRecording } from "./VoiceRecorder";
import { ActionButton } from "./ui";
const ApproveDevicePairing = lazy(() => import("./DevicePairing").then(({ ApproveDevicePairing }) => ({ default: ApproveDevicePairing })));

const pushLabels: Record<PushStatus, string> = {
  unsupported: "当前浏览器不支持 Web Push",
  off: "未开启",
  "permission-needed": "需要通知权限",
  blocked: "已被浏览器阻止",
  repairing: "正在修复订阅",
  on: "已开启（通知不含消息明文）",
  error: "订阅异常，请重试",
};

export function SettingsDialog({ runtime, pushStatus, pushBusy, onEnablePush, onDisablePush, onClose }: {
  runtime: BrowserMessagingRuntime;
  pushStatus: PushStatus;
  pushBusy: boolean;
  onEnablePush(): Promise<void>;
  onDisablePush(): Promise<void>;
  onClose(): void;
}) {
  const [devices, setDevices] = useState<ServerDevice[]>([]);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      runtime.api.devices().then((result) => result.devices),
      navigator.storage?.persisted?.() ?? Promise.resolve(false),
    ]).then(([nextDevices, nextPersistent]) => {
      if (active) { setDevices(nextDevices); setPersistent(nextPersistent); }
    }).catch(() => { if (active) setPersistent(false); });
    return () => { active = false; };
  }, [runtime]);

  async function protectStorage() {
    setStorageBusy(true);
    try { setPersistent(await (navigator.storage?.persist?.() ?? Promise.resolve(false))); }
    finally { setStorageBusy(false); }
  }

  return <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }} className="fixed inset-0 z-50 grid place-items-end bg-black/35 backdrop-blur-[1px] sm:place-items-center sm:p-6">
    <Modal className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl outline-none sm:max-w-lg sm:rounded-2xl">
      <Dialog aria-label="设置" className="outline-none">
        <header className="flex h-16 items-center justify-between border-b border-black/5 px-5"><Heading slot="title" className="font-semibold text-ink">设备与 PWA</Heading><ActionButton variant="icon" aria-label="关闭设置" onPress={onClose}><IconX className="size-5" /></ActionButton></header>
        <div className="grid gap-6 p-5">
          <section><h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><IconShieldLock className="size-4 text-brand" />当前加密身份</h2><p className="mt-2 break-all rounded-lg bg-neutral-50 px-3 py-2 text-xs/5 text-muted">{runtime.session.user_id}<br />设备：{runtime.session.device_id}</p></section>
          <section><h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><IconDeviceLaptop className="size-4 text-brand" />账户设备</h2><div className="mt-2 divide-y divide-black/5 rounded-xl ring-1 ring-black/5">{devices.map((device) => <div key={device.device_id} className="px-3 py-2.5"><p className="text-sm font-medium text-ink">{device.display_name}{device.device_id === runtime.session.device_id ? " · 当前设备" : ""}</p><p className="truncate text-xs text-muted">{device.device_id}{device.revoked_at ? " · 已撤销" : ""}</p></div>)}</div><Suspense fallback={<p role="status" className="mt-2 text-sm text-muted">正在打开设备配对…</p>}><ApproveDevicePairing runtime={runtime} onComplete={async () => setDevices((await runtime.api.devices()).devices)} /></Suspense></section>
          <section className="flex items-center gap-3"><IconBell className="size-5 shrink-0 text-brand" /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-ink">离线通知</h2><p className="text-xs/5 text-muted">{pushLabels[pushStatus]}</p></div>{pushStatus === "on" ? <ActionButton variant="quiet" isDisabled={pushBusy} onPress={() => void onDisablePush()}>关闭</ActionButton> : <ActionButton isDisabled={pushBusy || pushStatus === "unsupported" || pushStatus === "blocked"} onPress={() => void onEnablePush()}>开启</ActionButton>}</section>
          <section className="flex items-center gap-3"><IconDeviceLaptop className="size-5 shrink-0 text-brand" /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-ink">保护本机记录</h2><p className="text-xs/5 text-muted">{persistent === true ? "浏览器已授予持久存储" : persistent === false ? "浏览器仍可能在空间不足时清理记录" : "正在检查…"}</p></div>{persistent === false && <ActionButton variant="quiet" isDisabled={storageBusy} onPress={() => void protectStorage()}>申请保护</ActionButton>}</section>
          <section className="rounded-xl bg-amber-50 p-3 text-xs/5 text-amber-950"><h2 className="flex items-center gap-2 font-semibold"><IconInfoCircle className="size-4" />PWA 能力说明</h2><ul className="mt-1 list-disc space-y-1 pl-5"><li>支持文字、图片、语音和普通文件；语音录制：{supportsVoiceRecording() ? "可用" : "此浏览器不可用，可上传音频"}。</li><li>后台持续运行、系统级分享和通知行为受浏览器/系统限制。</li><li>图片语义搜索默认关闭，只有用户主动下载模型后才会启用；当前 React PWA 尚未下载模型。</li><li>PGlite 中含解密后的本机消息，E2EE 不防护已失陷的本地设备。</li></ul></section>
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>;
}
