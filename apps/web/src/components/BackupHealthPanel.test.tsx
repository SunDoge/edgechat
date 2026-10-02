import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupHealthPanel } from "./BackupHealthPanel";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("BackupHealthPanel", () => {
  it("keeps recovery risk and the backup action together", () => {
    const onBackup = vi.fn(); const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <BackupHealthPanel backup={null} onBackup={onBackup}/>, root);
    expect(root.textContent).toContain("还没有本机恢复备份");
    expect(root.textContent).toContain("无法从服务器恢复");
    root.querySelector("button")?.click();
    expect(onBackup).toHaveBeenCalledOnce();
  });
});
