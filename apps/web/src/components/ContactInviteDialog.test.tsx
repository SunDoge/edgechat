import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "@edgechat/protocol";
import { ContactInviteDialog } from "./ContactInviteDialog";

const profile: UserProfile = {
  user_id: "@alice:chat.example.com",
  display_name: "Alice",
  bio: "",
  avatar_url: null,
};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks();
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
});

describe("ContactInviteDialog", () => {
  it("renders an accessible QR and copies the minimal contact URL", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <ContactInviteDialog profile={profile} origin="https://chat.example.com" onClose={vi.fn()}/>, root);
    await Promise.resolve();
    expect(document.querySelector('[role="img"][aria-label="Alice 的联系人二维码"] svg')).not.toBeNull();
    expect(document.querySelector('[role="dialog"] img')).toBeNull();
    const copy = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "复制链接")!;
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("https://chat.example.com/?contact=%40alice%3Achat.example.com"));
    expect(document.body.textContent).toContain("不包含密码、设备密钥或聊天内容");
    expect(document.body.textContent).toContain("联系人链接已复制");
  });

  it("uses native share without adding device or key material", async () => {
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <ContactInviteDialog profile={profile} origin="https://chat.example.com" onClose={vi.fn()}/>, root);
    await Promise.resolve();
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "分享")!;
    action.click();
    await vi.waitFor(() => expect(share).toHaveBeenCalledWith({
      title: "Alice",
      text: "通过 EdgeChat 联系 Alice",
      url: "https://chat.example.com/?contact=%40alice%3Achat.example.com",
    }));
  });
});
