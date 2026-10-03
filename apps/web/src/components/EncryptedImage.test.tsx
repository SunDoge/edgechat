import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "../media";
import { EncryptedImage } from "./EncryptedImage";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined; document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

class ImmediateIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect() {}
}

const attachment = {
  id: "attachment_123456", name: "photo.jpg", type: "image/jpeg", size: 2048,
  key: "key", nonce: "nonce", width: 800, height: 600,
};

function mount(loadCached: () => Promise<ArrayBuffer | null>, load: () => Promise<ArrayBuffer>, value: AttachmentMetadata = attachment) {
  vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:edgechat-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => <EncryptedImage attachment={value} loadCached={loadCached} load={load} download={vi.fn()}/>, root);
}

describe("EncryptedImage remote-read policy", () => {
  it("checks only the local ciphertext cache while entering the viewport", async () => {
    const cached = vi.fn(async () => null); const remote = vi.fn(async () => new ArrayBuffer(4));
    mount(cached, remote);
    await vi.waitFor(() => expect(cached).toHaveBeenCalledOnce());
    expect(remote).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("加载图片 · 2.0 KB");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("加载图片"))?.click();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce());
    expect(document.querySelector('[aria-label="查看图片：photo.jpg"]')).not.toBeNull();
  });

  it("renders an existing local cache without a remote read", async () => {
    const cached = vi.fn(async () => new ArrayBuffer(4)); const remote = vi.fn(async () => new ArrayBuffer(4));
    mount(cached, remote);
    await vi.waitFor(() => expect(document.querySelector('[aria-label="查看图片：photo.jpg"]')).not.toBeNull());
    expect(remote).not.toHaveBeenCalled();
  });

  it("renders an E2EE embedded preview without an object read and loads the original only after activation", async () => {
    const cached = vi.fn(async () => null); const remote = vi.fn(async () => new ArrayBuffer(4));
    mount(cached, remote, { ...attachment, preview: { type: "image/webp" as const, data: "AQID", width: 64, height: 48 } });
    await vi.waitFor(() => expect(cached).toHaveBeenCalledOnce());
    expect(remote).not.toHaveBeenCalled();
    const loadOriginal = document.querySelector<HTMLButtonElement>('[aria-label="加载原图 photo.jpg，大小 2.0 KB"]');
    expect(loadOriginal).not.toBeNull();
    expect(document.body.textContent).toContain("加载原图 · 2.0 KB");
    loadOriginal?.click();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce());
    expect(document.querySelector('[aria-label="查看图片：photo.jpg"]')).not.toBeNull();
  });

  it("does not cancel an explicit original load when the parallel cache probe finishes empty", async () => {
    let finishCache!: (value: ArrayBuffer | null) => void; let finishRemote!: (value: ArrayBuffer) => void;
    const cached = vi.fn(() => new Promise<ArrayBuffer | null>((resolve) => { finishCache = resolve; }));
    const remote = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { finishRemote = resolve; }));
    mount(cached, remote, { ...attachment, preview: { type: "image/webp" as const, data: "AQID", width: 64, height: 48 } });
    await vi.waitFor(() => expect(cached).toHaveBeenCalledOnce());
    document.querySelector<HTMLButtonElement>('[aria-label="加载原图 photo.jpg，大小 2.0 KB"]')?.click();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce());
    finishCache(null);
    await Promise.resolve();
    expect(document.body.textContent).toContain("正在下载并解密…");
    finishRemote(new ArrayBuffer(4));
    await vi.waitFor(() => expect(document.querySelector('[aria-label="查看图片：photo.jpg"]')).not.toBeNull());
  });
});
