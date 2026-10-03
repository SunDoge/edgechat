import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@edgechat/sync";

const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(async () => ({
    id: "credential-id", rawId: "credential-id", type: "public-key",
    response: { clientDataJSON: "client-data", attestationObject: "attestation" },
    clientExtensionResults: {}, authenticatorAttachment: "platform",
  })),
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: webauthn.startRegistration,
}));

import { PasskeyDialog } from "./PasskeyDialog";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined; document.body.replaceChildren();
  vi.clearAllMocks();
});

function input(id: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(id)!;
  element.value = value; element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

describe("PasskeyDialog", () => {
  it("binds enrollment to the server-issued challenge and explains the E2EE boundary", async () => {
    const api = {
      passkeys: vi.fn(async () => ({ passkeys: [] })),
      passkeyRegistrationOptions: vi.fn(async () => ({
        challenge_id: "challenge-id",
        options: { challenge: "challenge", rp: { name: "EdgeChat", id: "edgechat.test" }, user: { id: "user", name: "@alice:edgechat.test", displayName: "Alice" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] },
      })),
      registerPasskey: vi.fn(async (_payload: Record<string, unknown>) => ({ credential_id: "credential-id", display_name: "Laptop", created_at: 1 })),
      deletePasskey: vi.fn(),
    };
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PasskeyDialog api={api as unknown as ApiClient} onClose={vi.fn()}/>, root);
    await vi.waitFor(() => expect(api.passkeys).toHaveBeenCalledOnce());
    expect(document.body.textContent).toContain("不包含设备私钥、MLS 群组状态或本机聊天记录");

    input("#passkey-name", "Laptop"); input("#passkey-password", "correct-horse-battery");
    const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "添加通行密钥")!;
    add.click();
    await vi.waitFor(() => expect(api.registerPasskey).toHaveBeenCalledOnce());
    expect(api.passkeyRegistrationOptions).toHaveBeenCalledWith("correct-horse-battery", "Laptop");
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: "challenge" }) });
    expect(api.registerPasskey).toHaveBeenCalledWith(expect.objectContaining({ challenge_id: "challenge-id", challenge: "challenge", response: expect.objectContaining({ id: "credential-id" }) }));
    expect(api.registerPasskey.mock.calls[0]?.[0]).not.toHaveProperty("display_name");
  });

  it("uses the device-held opaque credential without asking the user for a password", async () => {
    const api = {
      passkeys: vi.fn(async () => ({ passkeys: [] })),
      passkeyRegistrationOptions: vi.fn(async () => ({ challenge_id: "opaque-challenge", options: { challenge: "opaque", rp: { name: "EdgeChat", id: "edgechat.test" }, user: { id: "user", name: "opaque", displayName: "Alice" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] } })),
      registerPasskey: vi.fn(async () => ({ credential_id: "credential-id", display_name: "Laptop", created_at: 1 })),
      deletePasskey: vi.fn(),
    };
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PasskeyDialog api={api as unknown as ApiClient} accountCredential={"z".repeat(43)} onClose={vi.fn()}/>, root);
    await vi.waitFor(() => expect(api.passkeys).toHaveBeenCalledOnce());
    expect(document.querySelector("#passkey-password")).toBeNull();
    input("#passkey-name", "Laptop");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "添加通行密钥")!.click();
    await vi.waitFor(() => expect(api.passkeyRegistrationOptions).toHaveBeenCalledWith("z".repeat(43), "Laptop"));
  });

  it("does not expose raw server diagnostics", async () => {
    const api = {
      passkeys: vi.fn(async () => { throw new ApiError("d1 trace and internal table", 503, "internal_error"); }),
    };
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <PasskeyDialog api={api as unknown as ApiClient} onClose={vi.fn()}/>, root);
    await vi.waitFor(() => expect(document.body.textContent).toContain("服务器暂时不可用，请稍后再试"));
    expect(document.body.textContent).not.toContain("d1 trace");
  });
});
