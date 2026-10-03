// @vitest-environment jsdom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoticeToast } from "./NoticeToast";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.textContent = ""; });

describe("NoticeToast", () => {
  it("announces ordinary feedback politely", () => {
    const host = document.createElement("div"); document.body.append(host);
    dispose = render(() => <NoticeToast text="已复制" priority="status" dismissLabel="关闭" placement="bottom" onDismiss={vi.fn()}/>, host);
    const notice = host.querySelector('[role="status"]');
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(notice?.textContent).toContain("已复制");
  });

  it("announces action failures assertively and keeps dismissal accessible", () => {
    const onDismiss = vi.fn(); const host = document.createElement("div"); document.body.append(host);
    dispose = render(() => <NoticeToast text="发送失败" priority="alert" dismissLabel="关闭提示" placement="top" onDismiss={onDismiss}/>, host);
    const notice = host.querySelector('[role="alert"]');
    expect(notice?.getAttribute("aria-live")).toBe("assertive");
    expect(notice?.getAttribute("aria-atomic")).toBe("true");
    (host.querySelector('button[aria-label="关闭提示"]') as HTMLButtonElement).click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
