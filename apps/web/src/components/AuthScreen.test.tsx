import "fake-indexeddb/auto";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalDatabase } from "@edgechat/db";
import type { DeviceIdentity, WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { ApiClient } from "@edgechat/sync";
import { clearIdentity, saveIdentity } from "../vault";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: vi.fn(),
}));

import { AuthScreen } from "./AuthScreen";

let dispose: (() => void) | undefined;
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  dispose?.(); dispose = undefined;
  document.body.replaceChildren();
  sessionStorage.clear(); localStorage.clear();
  await clearIdentity(PROFILE_ID);
});

function renderAuth(accountHint?: string) {
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => <AuthScreen
    profileId={PROFILE_ID}
    accountHint={accountHint}
    api={{} as ApiClient}
    core={{} as WebCryptoMessagingCore}
    db={{} as LocalDatabase}
    onReady={vi.fn()}
    onRestoreBackup={vi.fn(async () => undefined)}
    onManageProfiles={vi.fn()}
  />, root);
}

describe("AuthScreen account identity", () => {
  it("asks only for a public nickname and hides internal account credentials", () => {
    renderAuth();
    const displayName = document.querySelector<HTMLInputElement>("#display-name")!;

    expect(displayName.labels?.[0]?.textContent).toContain("显示名称");
    expect(displayName.getAttribute("aria-describedby")).toBe("display-name-help");
    expect(document.querySelector("#username")).toBeNull();
    expect(document.querySelector("#password")).toBeNull();
    expect(document.body.textContent).toContain("内部地址会自动生成");
    expect(document.body.textContent).toContain("账户凭据");
  });

  it("accepts either the short account name or full user ID on login", () => {
    renderAuth();
    const loginTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "登录")!;
    loginTab.click();

    const username = document.querySelector<HTMLInputElement>("#username")!;
    expect(username.labels?.[0]?.textContent).toContain("账号名或用户 ID");
    expect(username.placeholder).toContain("@alice:example.com");
    expect(document.querySelector<HTMLInputElement>("#password")).not.toBeNull();
  });

  it("offers device continuation only when this profile retains its possession credential", async () => {
    await saveIdentity(PROFILE_ID, { deviceId: "device", deviceCredential: "credential", mlsState: new Uint8Array([1]) } as DeviceIdentity);
    renderAuth("@alice:example.com");
    await vi.waitFor(() => expect(document.body.textContent).toContain("使用这台设备继续"));
    expect(document.querySelector<HTMLInputElement>("#username")?.value).toBe("@alice:example.com");
    expect(document.body.textContent).toContain("或使用登录密码");
    expect(document.body.textContent).toContain("使用通行密钥登录");
  });

  it("does not present passkey login as a replacement for missing local device keys", async () => {
    renderAuth("@alice:example.com");
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("使用通行密钥登录");
    expect(document.body.textContent).toContain("链接已有账户");
    expect(document.body.textContent).toContain("从加密备份恢复");
  });
});
