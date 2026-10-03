import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupRestoreForm } from "./BackupRestoreForm";
import { StartupRecoveryScreen } from "./StartupRecoveryScreen";
import { INTERRUPTED_RESTORE_FAILURE } from "../startup-recovery";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("StartupRecoveryScreen", () => {
  it("offers only non-destructive first-line recovery actions", () => {
    const retry = vi.fn(); const manage = vi.fn();
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <StartupRecoveryScreen
      failure={{ kind: "local-database", code: "LOCAL_DATABASE_UNAVAILABLE", title: "本机消息库未能安全打开", summary: "你的本机记录没有被自动删除。", primaryAction: "重新尝试打开", primaryIntent: "retry" }}
      profileName="Alice" onRetry={retry} onManageProfiles={manage} onRestoreBackup={vi.fn()}/>, root);
    expect(root.textContent).toContain("你的本机记录没有被自动删除");
    expect(root.textContent).toContain("不要通过清除浏览器数据来尝试修复");
    expect(root.textContent).not.toContain("删除本机身份");
    const buttons = [...root.querySelectorAll("button")];
    buttons.find((button) => button.textContent?.includes("重新尝试打开"))?.click();
    buttons.find((button) => button.textContent?.includes("切换本机身份"))?.click();
    expect(retry).toHaveBeenCalledOnce(); expect(manage).toHaveBeenCalledOnce();
  });

  it("explains that backup validation happens before replacement", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <StartupRecoveryScreen
      failure={{ kind: "unknown", code: "STARTUP_UNEXPECTED_FAILURE", title: "暂时无法打开", summary: "本机数据仍保留。", primaryAction: "重试", primaryIntent: "retry" }}
      profileName="Alice" onRetry={vi.fn()} onManageProfiles={vi.fn()} onRestoreBackup={vi.fn()}/>, root);
    [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("从加密备份恢复"))?.click();
    expect(root.textContent).toContain("备份会先在新的本机存储区中完整验证");
    expect(root.textContent).toContain("验证失败不会覆盖当前记录");
    expect(root.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("requires the backup password and explicit replacement confirmation", async () => {
    const restore = vi.fn(async (_file: File, _password: string) => undefined);
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <BackupRestoreForm onRestore={restore} onCancel={vi.fn()}/>, root);
    const submit = root.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const fileInput = root.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["encrypted"], "backup.edgechat-backup")] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    const input = root.querySelector("#restore-password") as HTMLInputElement;
    input.value = "backup password"; input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "backup password" }));
    (root.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    expect(submit.disabled).toBe(false);
    root.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(restore.mock.calls[0]?.[0].name).toBe("backup.edgechat-backup");
    expect(restore.mock.calls[0]?.slice(1)).toEqual(["backup password"]);
  });

  it("opens backup selection instead of looping reload after an interrupted restore", () => {
    const retry = vi.fn();
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <StartupRecoveryScreen failure={INTERRUPTED_RESTORE_FAILURE} profileName="Alice" onRetry={retry} onManageProfiles={vi.fn()} onRestoreBackup={vi.fn()}/>, root);
    [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("重新选择备份"))?.click();
    expect(retry).not.toHaveBeenCalled();
    expect(root.querySelector('input[type="file"]')).not.toBeNull();
  });
});
