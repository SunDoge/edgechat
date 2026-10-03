// @vitest-environment jsdom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, transferredFiles } from "./index";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

function transfer(files: File[], withFileType = true): DataTransfer {
  return {
    files,
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    types: withFileType ? ["Files"] : ["text/plain"],
    dropEffect: "none",
  } as unknown as DataTransfer;
}

function mount(onFiles: (files: File[]) => void) {
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => <ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} onFiles={onFiles} dropLabel="松开添加"/>, root);
  return { form: root.querySelector("form")!, textarea: root.querySelector("textarea")! };
}

describe("chat composer file transfer", () => {
  it("prefers the direct file list and falls back to clipboard items", () => {
    const file = new File(["photo"], "photo.png", { type: "image/png" });
    expect(transferredFiles(transfer([file]))).toEqual([file]);
    expect(transferredFiles({ files: [] as unknown as FileList, items: transfer([file]).items })).toEqual([file]);
  });

  it("captures file paste but leaves ordinary text paste untouched", () => {
    const onFiles = vi.fn(); const { textarea } = mount(onFiles);
    const textPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", { value: transfer([], false) });
    expect(textarea.dispatchEvent(textPaste)).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();

    const file = new File(["photo"], "photo.png", { type: "image/png" });
    const filePaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(filePaste, "clipboardData", { value: transfer([file]) });
    expect(textarea.dispatchEvent(filePaste)).toBe(false);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("does not capture files when attachment admission is unavailable", () => {
    const root = document.createElement("div"); document.body.append(root);
    const onFiles = vi.fn();
    dispose = render(() => <ChatComposer value="editing" onChange={vi.fn()} onSend={vi.fn()} dropLabel="松开添加"/>, root);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: transfer([new File(["x"], "photo.png")]) });
    expect(root.querySelector("textarea")!.dispatchEvent(paste)).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("shows a drop target and admits files only on an actual file drop", () => {
    const onFiles = vi.fn(); const { form } = mount(onFiles);
    const file = new File(["document"], "document.pdf", { type: "application/pdf" });
    const drag = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(drag, "dataTransfer", { value: transfer([file]) });
    form.dispatchEvent(drag);
    expect(document.body.textContent).toContain("松开添加");

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer([file]) });
    form.dispatchEvent(drop);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(document.body.textContent).not.toContain("松开添加");
  });
});
