import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalDatabase } from "@edgechat/db";
import type { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { ApiClient } from "@edgechat/sync";
import { AuthScreen } from "./AuthScreen";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.(); dispose = undefined;
  document.body.replaceChildren();
  sessionStorage.clear(); localStorage.clear();
});

function renderAuth() {
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => <AuthScreen
    profileId="00000000-0000-4000-8000-000000000001"
    api={{} as ApiClient}
    core={{} as WebCryptoMessagingCore}
    db={{} as LocalDatabase}
    onReady={vi.fn()}
    onRestoreBackup={vi.fn(async () => undefined)}
    onManageProfiles={vi.fn()}
  />, root);
}

describe("AuthScreen account identity", () => {
  it("asks for one account name and explains the separate login credential", () => {
    renderAuth();
    const username = document.querySelector<HTMLInputElement>("#username")!;
    const password = document.querySelector<HTMLInputElement>("#password")!;

    expect(document.querySelector("#display-name")).toBeNull();
    expect(username.labels?.[0]?.textContent).toContain("账号名");
    expect(username.getAttribute("aria-describedby")).toBe("account-name-help");
    expect(password.labels?.[0]?.textContent).toContain("登录密码");
    expect(password.getAttribute("aria-describedby")).toBe("login-password-help");
    expect(document.body.textContent).toContain("昵称先使用账号名");
    expect(document.body.textContent).toContain("不是消息密钥");
    expect(document.body.textContent).toContain("不能恢复已丢失的聊天记录");
  });

  it("accepts either the short account name or full user ID on login", () => {
    renderAuth();
    const loginTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "登录")!;
    loginTab.click();

    const username = document.querySelector<HTMLInputElement>("#username")!;
    expect(username.labels?.[0]?.textContent).toContain("账号名或用户 ID");
    expect(username.placeholder).toContain("@alice:example.com");
    expect(document.querySelector("#account-name-help")).toBeNull();
  });
});
