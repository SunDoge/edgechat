import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@edgechat/sync";
import { DeviceLinkApprovalDialog } from "./DeviceLinkApprovalDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("DeviceLinkApprovalDialog", () => {
  it("explains the approval boundary and offers paste recovery without camera support", () => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <DeviceLinkApprovalDialog api={{} as ApiClient} onApprove={vi.fn(async () => undefined)} onCancelLink={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root);
    expect(document.body.textContent).toContain("二维码本身不能读取消息，也不会自动批准");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "扫描二维码")?.click();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("复制链接后粘贴到下方");
    expect(document.querySelector<HTMLInputElement>("#device-link-code")?.placeholder).toBe("粘贴链接或链接码");
  });

  it("offers a hard cancellation after approval has started and failed", async () => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const linkId = "abcdefghijklmnop";
    const onApprove = vi.fn(async () => { throw new Error("加入过程中断"); });
    const onCancelLink = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const api = { deviceLinkPreview: vi.fn(async () => ({
      link_id: linkId, device_id: "new-device", display_name: "New phone",
      signing_key: { kty: "EC", crv: "P-256", x: "sign-x", y: "sign-y" },
      encryption_key: { kty: "EC", crv: "P-256", x: "encrypt-x", y: "encrypt-y" },
      status: "pending" as const, required_packages: 1, expires_at: Date.now() + 60_000,
      history_transfer: null, account_credential_ready: false, rooms: [],
    })) } as unknown as ApiClient;
    dispose = render(() => <DeviceLinkApprovalDialog api={api} onApprove={onApprove} onCancelLink={onCancelLink} onClose={onClose}/>, root);

    const input = document.querySelector<HTMLInputElement>("#device-link-code")!;
    input.value = linkId; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document.querySelector<HTMLFormElement>("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("New phone"));
    const confirmation = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    confirmation.checked = true; confirmation.dispatchEvent(new Event("change", { bubbles: true }));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "核对后批准")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("设备链接没有完成，可再次尝试"));
    expect(document.body.textContent).not.toContain("加入过程中断");

    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "撤销这次链接")!.click();
    await vi.waitFor(() => expect(onCancelLink).toHaveBeenCalledWith(linkId));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
