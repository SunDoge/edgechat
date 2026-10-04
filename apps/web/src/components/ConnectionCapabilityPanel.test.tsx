import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionCapabilityPanel } from "./ConnectionCapabilityPanel";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("ConnectionCapabilityPanel", () => {
  it("offers a bounded realtime retry while compatibility sync remains usable", async () => {
    const retry = vi.fn(async () => { throw new TypeError("blocked"); });
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <ConnectionCapabilityPanel state="online" mode="https" onRetryRealtime={retry}/>, root);

    expect(root.textContent).toContain("HTTPS 兼容模式");
    expect(root.textContent).toContain("消息仍会定时同步");
    expect(root.querySelector("details")?.open).toBe(false);
    [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("重试实时连接"))?.click();

    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(root.textContent).toContain("暂时无法恢复实时连接");
  });

  it("does not suggest a redundant retry while realtime is healthy", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <ConnectionCapabilityPanel state="online" mode="websocket" onRetryRealtime={vi.fn()}/>, root);

    expect(root.textContent).toContain("实时连接");
    expect(root.querySelector("button")).toBeNull();
  });
});
