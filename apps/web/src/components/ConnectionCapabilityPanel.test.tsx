import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionCapabilityPanel } from "./ConnectionCapabilityPanel";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("ConnectionCapabilityPanel", () => {
  it("offers a bounded realtime retry while compatibility sync remains usable", async () => {
    const retry = vi.fn(async () => { throw new TypeError("blocked"); });
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <ConnectionCapabilityPanel state="online" mode="https" httpsOnly={false} onHttpsOnly={vi.fn()} onRetryRealtime={retry}/>, root);

    expect(root.textContent).toContain("HTTPS 兼容模式");
    expect(root.textContent).toContain("消息仍会定时同步");
    expect(root.querySelector("details")?.open).toBe(false);
    [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("重试实时连接"))?.click();

    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(root.textContent).toContain("暂时无法恢复实时连接");
  });

  it("does not suggest a redundant retry while realtime is healthy", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <ConnectionCapabilityPanel state="online" mode="websocket" httpsOnly={false} onHttpsOnly={vi.fn()} onRetryRealtime={vi.fn()}/>, root);

    expect(root.textContent).toContain("实时连接");
    expect([...root.querySelectorAll("button")].some((button) => button.textContent?.includes("重试实时连接"))).toBe(false);
  });

  it("lets the user deliberately keep this profile on HTTPS without suggesting a realtime retry", async () => {
    const change = vi.fn(async () => undefined);
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <ConnectionCapabilityPanel state="online" mode="https" httpsOnly onHttpsOnly={change} onRetryRealtime={vi.fn()}/>, root);

    expect(root.textContent).toContain("已按这台设备的设置停用实时连接");
    expect(root.textContent).not.toContain("重试实时连接");
    const preference = root.querySelector<HTMLButtonElement>('[role="switch"][aria-label="始终使用 HTTPS 兼容模式"]')!;
    expect(preference.getAttribute("aria-checked")).toBe("true");
    preference.click();
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith(false));
  });
});
