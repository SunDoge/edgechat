import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@edgechat/sync";
import { DeviceLinkApprovalDialog } from "./DeviceLinkApprovalDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("DeviceLinkApprovalDialog", () => {
  it("explains the approval boundary and offers paste recovery without camera support", () => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <DeviceLinkApprovalDialog api={{} as ApiClient} onApprove={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root);
    expect(document.body.textContent).toContain("二维码本身不能读取消息，也不会自动批准");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "扫描二维码")?.click();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("复制链接后粘贴到下方");
    expect(document.querySelector<HTMLInputElement>("#device-link-code")?.placeholder).toBe("粘贴链接或链接码");
  });
});
