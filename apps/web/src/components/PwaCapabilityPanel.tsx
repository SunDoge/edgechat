import { For, Show } from "solid-js";
import { IconInfoCircle } from "@tabler/icons-solidjs";
import type { PushStatus } from "../push-subscription";

export function PwaCapabilityPanel(props: { pushConfigured: boolean; pushStatus: PushStatus; voiceRecordingAvailable: boolean }) {
  const limitations = () => {
    const items = ["浏览器或系统可能暂停后台运行，通知和后台发送会延迟；重新打开后会自动同步遗漏的加密消息。"];
    if (!props.pushConfigured) items.push("此服务器尚未配置离线通知；关闭页面后不会收到系统提醒。");
    else if (props.pushStatus === "unsupported") items.push("此浏览器不支持离线通知；打开 EdgeChat 后仍会正常补齐消息。");
    else if (props.pushStatus === "blocked") items.push("通知权限已被浏览器阻止，可在本站权限设置中重新允许。");
    if (!props.voiceRecordingAvailable) items.push("此浏览器不能直接录音；仍可通过附件按钮发送已有音频文件。");
    items.push("从系统分享或用 EdgeChat 打开文件取决于浏览器和操作系统；不支持时可直接在聊天中选择文件。");
    return items;
  };

  return <section class="border-b border-black/5 p-5" aria-labelledby="pwa-capabilities-title">
    <div class="flex items-start gap-3">
      <IconInfoCircle class="mt-0.5 size-4 shrink-0 stroke-muted"/>
      <div class="min-w-0 flex-1">
        <strong id="pwa-capabilities-title" class="text-sm font-medium text-ink">PWA 能力与限制</strong>
        <p class="mt-1 text-xs/5 text-muted">文字、图片、语音和文件是 PWA 的基础功能。消息内容仍在本机加密和解密。</p>
        <ul class="mt-2 grid gap-1.5 text-xs/5 text-muted">
          <For each={limitations()}>{(item) => <li class="flex gap-2"><span aria-hidden="true" class="mt-2 size-1 shrink-0 rounded-full bg-neutral-400"/><span>{item}</span></li>}</For>
        </ul>
        <Show when={props.pushConfigured && props.pushStatus === "on"}><p class="mt-2 text-xs/5 text-emerald-700">这台设备已开启离线通知，但消息送达仍以重新打开后的同步结果为准。</p></Show>
      </div>
    </div>
  </section>;
}
