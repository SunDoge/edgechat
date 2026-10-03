import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDeletionDialog, BackupDialog, DevicesDialog } from "./UtilityDialogs";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function root(): HTMLDivElement {
  const element = document.createElement("div"); document.body.append(element); return element;
}

describe("account safety dialogs", () => {
  it("requires the localized destructive phrase before account deletion", async () => {
    const onDelete = vi.fn(async () => undefined);
    dispose = render(() => <AccountDeletionDialog onDelete={onDelete} onClose={vi.fn()}/>, root());
    const password = document.querySelector<HTMLInputElement>("#delete-account-password")!;
    const confirmation = document.querySelector<HTMLInputElement>("#delete-account-confirmation")!;
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "永久删除")!;
    password.value = "correct horse battery staple"; password.dispatchEvent(new InputEvent("input", { bubbles: true }));
    confirmation.value = "delete account"; confirmation.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(action.disabled).toBe(true);
    confirmation.value = "删除账户"; confirmation.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(action.disabled).toBe(false); action.click();
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("correct horse battery staple"));
  });

  it("uses a device-held opaque credential for deletion without exposing a password field", async () => {
    const onDelete = vi.fn(async () => undefined);
    dispose = render(() => <AccountDeletionDialog accountCredential={"q".repeat(43)} onDelete={onDelete} onClose={vi.fn()}/>, root());
    expect(document.querySelector("#delete-account-password")).toBeNull();
    const confirmation = document.querySelector<HTMLInputElement>("#delete-account-confirmation")!;
    confirmation.value = "删除账户"; confirmation.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "永久删除")!;
    expect(action.disabled).toBe(false); action.click();
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("q".repeat(43)));
  });

  it("states that a portable backup does not duplicate messages into cloud storage", () => {
    dispose = render(() => <BackupDialog onCreate={vi.fn()} onClose={vi.fn()}/>, root());
    expect(document.body.textContent).toContain("服务器仅保存一个不含消息内容的防回滚检查点");
    expect(document.body.textContent).toContain("不复制消息或附件");
  });

  it("keeps cloud object usage separate and itemized", () => {
    const noop = vi.fn(); const asyncNoop = vi.fn(async () => undefined);
    dispose = render(() => <DevicesDialog
      devices={[]} revocations={{}} profile={null}
      storage={{ attachment_bytes: 1024, archive_bytes: 2048, avatar_bytes: 512, attachment_objects: 1, archive_objects: 1, avatar_objects: 1, used_bytes: 3584, quota_bytes: 1_048_576, remaining_bytes: 1_044_992, used_objects: 3, object_limit: 100, remaining_objects: 97, quota_source: "default", updated_at: 1 }}
      localStorageHealth={null} backup={null} invitationPolicy="everyone" installState={{ status: "unavailable", platform: "browser" }}
      currentDeviceId="device" pushAvailable={false} pushStatus="off" voiceRecordingAvailable passwordChangeSupported passkeysSupported linkPreviews={false} presenceSharing={false} exportBusy={false}
      onEditProfile={noop} onInvitationPolicy={asyncNoop} onLinkPreviews={asyncNoop} onPresenceSharing={asyncNoop} onRequestPersistence={vi.fn(async () => ({ outcome: "unsupported" as const, health: { persistence: "unsupported" as const, canRequestPersistence: false, usage: null, quota: null } }))}
      onInstall={noop} onLinkDevice={noop} onEnablePush={noop} onDisablePush={noop} onBackup={noop} onChangePassword={noop} onManagePasskeys={noop} onExport={noop} onDeleteAccount={noop} onRevoke={noop} onLogout={noop} onClose={noop}/>, root());
    expect(document.body.textContent).toContain("云端加密存储");
    expect(document.body.textContent).toContain("附件 1.0 KB · 消息历史 2.0 KB · 头像 512 B");
  });
});
