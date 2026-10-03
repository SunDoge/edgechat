import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { PwaCapabilityPanel } from "./PwaCapabilityPanel";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("PwaCapabilityPanel", () => {
  it("explains browser recovery and unsupported baseline inputs without technical jargon", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PwaCapabilityPanel pushConfigured pushStatus="unsupported" voiceRecordingAvailable={false} qrScanningAvailable={false}/>, root);
    expect(root.textContent).toContain("文字、图片、语音和文件是 PWA 的基础功能");
    expect(root.textContent).toContain("重新打开后会自动同步遗漏的加密消息");
    expect(root.textContent).toContain("此浏览器不支持离线通知");
    expect(root.textContent).toContain("仍可通过附件按钮发送已有音频文件");
    expect(root.textContent).toContain("联系人可用完整用户 ID 搜索");
    expect(root.textContent).not.toContain("Web Push");
  });

  it("distinguishes missing server notification setup from a PWA limitation", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PwaCapabilityPanel pushConfigured={false} pushStatus="unsupported" voiceRecordingAvailable qrScanningAvailable/>, root);
    expect(root.textContent).toContain("此服务器尚未配置离线通知");
    expect(root.textContent).not.toContain("此浏览器不支持离线通知");
  });
});
