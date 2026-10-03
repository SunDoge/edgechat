import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDeletionDialog, DevicesDialog } from "./UtilityDialogs";
import { BackupDialog } from "./BackupDialog";

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

  it("states that a portable backup does not duplicate messages into cloud storage", async () => {
    dispose = render(() => <BackupDialog checkCachedMediaSupport={async () => true} onCreate={vi.fn()} onClose={vi.fn()}/>, root());
    expect(document.body.textContent).toContain("服务器仅保存一个不含消息内容的防回滚检查点");
    expect(document.body.textContent).toContain("不会上传备份或复制云端对象");
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#backup-cached-media")?.checked).toBe(true));
  });

  it("allows a smaller database-only backup only through an explicit choice", async () => {
    const onCreate = vi.fn(async () => undefined);
    dispose = render(() => <BackupDialog checkCachedMediaSupport={async () => true} onCreate={onCreate} onClose={vi.fn()}/>, root());
    const include = document.querySelector<HTMLInputElement>("#backup-cached-media")!;
    await vi.waitFor(() => expect(include.checked).toBe(true));
    include.click();
    for (const [selector, value] of [["#backup-password", "correct horse battery"], ["#backup-confirmation", "correct horse battery"]] as const) {
      const input = document.querySelector<HTMLInputElement>(selector)!; input.value = value; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith("correct horse battery", false));
  });

  it("discloses an OPFS limitation and creates a database-only backup", async () => {
    const onCreate = vi.fn(async () => undefined);
    dispose = render(() => <BackupDialog checkCachedMediaSupport={async () => false} onCreate={onCreate} onClose={vi.fn()}/>, root());
    const include = document.querySelector<HTMLInputElement>("#backup-cached-media")!;
    await vi.waitFor(() => expect(document.body.textContent).toContain("此浏览器无法读取本机媒体缓存"));
    expect(include.checked).toBe(false); expect(include.disabled).toBe(true);
    for (const [selector, value] of [["#backup-password", "correct horse battery"], ["#backup-confirmation", "correct horse battery"]] as const) {
      const input = document.querySelector<HTMLInputElement>(selector)!; input.value = value; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith("correct horse battery", false));
  });

  it("keeps cloud object usage separate and exposes device-local metadata controls", async () => {
    const noop = vi.fn(); const asyncNoop = vi.fn(async () => undefined);
    const onReadReceiptSharing = vi.fn(async () => undefined);
    const onTypingIndicatorSharing = vi.fn(async () => undefined);
    dispose = render(() => <DevicesDialog
      devices={[]} revocations={{}} profile={null}
      storage={{ attachment_bytes: 1024, archive_bytes: 2048, avatar_bytes: 512, attachment_objects: 1, archive_objects: 1, avatar_objects: 1, used_bytes: 3584, quota_bytes: 1_048_576, remaining_bytes: 1_044_992, used_objects: 3, object_limit: 100, remaining_objects: 97, quota_source: "default", updated_at: 1 }}
      localStorageHealth={null} backup={null} invitationPolicy="everyone" installState={{ status: "unavailable", platform: "browser" }}
      currentDeviceId="device" pushAvailable={false} pushStatus="off" voiceRecordingAvailable qrScanningAvailable passwordChangeSupported passkeysSupported linkPreviews={false} presenceSharing={false} readReceiptSharing={false} typingIndicatorSharing={false} exportBusy={false}
      onEditProfile={noop} onShareContact={noop} onInvitationPolicy={asyncNoop} onLinkPreviews={asyncNoop} onPresenceSharing={asyncNoop} onReadReceiptSharing={onReadReceiptSharing} onTypingIndicatorSharing={onTypingIndicatorSharing} onRequestPersistence={vi.fn(async () => ({ outcome: "unsupported" as const, health: { persistence: "unsupported" as const, canRequestPersistence: false, usage: null, quota: null } }))}
      onInstall={noop} onLinkDevice={noop} onEnablePush={noop} onDisablePush={noop} onBackup={noop} onChangePassword={noop} onManagePasskeys={noop} onExport={noop} onDeleteAccount={noop} onRevoke={noop} onLogout={noop} onClose={noop}/>, root());
    expect(document.body.textContent).toContain("云端加密存储");
    expect(document.body.textContent).toContain("附件 1.0 KB · 消息历史 2.0 KB · 头像 512 B");
    const switches = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'));
    switches.find((button) => button.getAttribute("aria-label") === "发送已读回执")!.click();
    switches.find((button) => button.getAttribute("aria-label") === "发送正在输入状态")!.click();
    await vi.waitFor(() => {
      expect(onReadReceiptSharing).toHaveBeenCalledWith(true);
      expect(onTypingIndicatorSharing).toHaveBeenCalledWith(true);
    });
  });
});
