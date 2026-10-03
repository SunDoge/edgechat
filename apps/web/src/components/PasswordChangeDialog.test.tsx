import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@edgechat/sync";
import { PasswordChangeDialog } from "./PasswordChangeDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

function input(id: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`#${id}`)!;
  field.value = value; field.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

describe("PasswordChangeDialog", () => {
  it("requires confirmation and defaults to expiring other device sessions", async () => {
    const change = vi.fn(async () => undefined); const close = vi.fn();
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PasswordChangeDialog onChange={change} onClose={close}/>, root);
    expect(document.body.textContent).toContain("不会远程删除它们已经保存的本地消息");
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    input("current-account-password", "old-correct-password");
    input("new-account-password", "new-correct-password");
    input("new-account-password-confirmation", "new-correct-password");
    document.querySelector<HTMLFormElement>("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("old-correct-password", "new-correct-password", true));
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not submit a reused or mismatched password", () => {
    const change = vi.fn(async () => undefined); const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PasswordChangeDialog onChange={change} onClose={() => undefined}/>, root);
    input("current-account-password", "same-password"); input("new-account-password", "same-password"); input("new-account-password-confirmation", "different-password");
    expect(document.body.textContent).toContain("新密码不能与当前密码相同");
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("translates authentication failures instead of displaying server text", async () => {
    const change = vi.fn(async () => { throw new ApiError("password verifier internals", 401, "invalid_credentials"); });
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PasswordChangeDialog onChange={change} onClose={() => undefined}/>, root);
    input("current-account-password", "old-correct-password");
    input("new-account-password", "new-correct-password");
    input("new-account-password-confirmation", "new-correct-password");
    document.querySelector<HTMLFormElement>("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("用户名或密码不正确"));
    expect(document.body.textContent).not.toContain("verifier internals");
  });
});
