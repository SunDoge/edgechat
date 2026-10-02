import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalStorageHealth } from "../local-storage-health";
import { LocalStoragePanel } from "./LocalStoragePanel";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("LocalStoragePanel", () => {
  it("separates approximate local usage from cloud quota and requests persistence explicitly", async () => {
    const initial: LocalStorageHealth = { persistence: "best-effort", canRequestPersistence: true, usage: 512 * 1024 ** 2, quota: 2 * 1024 ** 3 };
    const persistent: LocalStorageHealth = { ...initial, persistence: "persistent", canRequestPersistence: false };
    const request = vi.fn(async () => ({ outcome: "granted" as const, health: persistent }));
    const root = document.createElement("div"); document.body.append(root);
    const [health, setHealth] = createSignal<LocalStorageHealth | null>(initial);
    dispose = render(() => <LocalStoragePanel health={health()} onRequestPersistence={async () => { const result = await request(); setHealth(result.health); return result; }}/>, root);
    expect(root.textContent).toContain("约 512.0 MB / 2.00 GB");
    expect(root.textContent).toContain("不是云端 R2 配额");
    expect(request).not.toHaveBeenCalled();
    [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("保护本机记录"))?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(root.textContent).toContain("浏览器已将本站数据标记为持久存储");
  });

  it("does not promise durability after denial and warns under origin quota pressure", async () => {
    const health: LocalStorageHealth = { persistence: "best-effort", canRequestPersistence: true, usage: 900, quota: 1_000 };
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <LocalStoragePanel health={health} onRequestPersistence={async () => ({ outcome: "denied", health })}/>, root);
    expect(root.textContent).toContain("浏览器可能自动清理");
    expect(root.textContent).toContain("本机空间偏紧");
    [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("保护本机记录"))?.click();
    await vi.waitFor(() => expect(root.textContent).toContain("浏览器未授予持久存储"));
    expect(root.textContent).toContain("不能替代加密备份");
  });
});
