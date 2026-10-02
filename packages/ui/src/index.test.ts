import { describe, expect, it } from "vitest";
import { anchoredScrollTop, buildVirtualLayout, isNearMessageListBottom, shouldSubmitComposer, virtualRange } from "./index";

describe("chat composer IME handling", () => {
  it("does not submit while a CJK IME is composing", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13 }, false)).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }, false)).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }, true)).toBe(false);
  });

  it("submits plain Enter but preserves Shift+Enter", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }, false)).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }, false)).toBe(false);
  });
});

describe("message list scroll anchoring", () => {
  it("keeps the same visible content when older messages are prepended", () => {
    expect(anchoredScrollTop(1_000, 1_400, 120, 600, false)).toBe(520);
  });

  it("continues following the bottom only when the reader was already there", () => {
    expect(anchoredScrollTop(1_000, 1_120, 400, 600, true)).toBe(520);
    expect(anchoredScrollTop(1_000, 900, 120, 600, false)).toBe(120);
  });

  it("uses a small bottom tolerance without treating older context as current", () => {
    expect(isNearMessageListBottom(2_000, 1_320, 600)).toBe(true);
    expect(isNearMessageListBottom(2_000, 1_299, 600)).toBe(false);
  });
});

describe("virtual message layout", () => {
  it("uses measured row heights without losing estimated rows", () => {
    const layout = buildVirtualLayout(["a", "b", "c"], new Map([["b", 120]]), 80);
    expect(layout.items).toEqual([
      { key: "a", index: 0, top: 0, height: 80 },
      { key: "b", index: 1, top: 80, height: 120 },
      { key: "c", index: 2, top: 200, height: 80 },
    ]);
    expect(layout.totalHeight).toBe(280);
  });

  it("returns only the visible rows plus pixel overscan", () => {
    const layout = buildVirtualLayout(Array.from({ length: 100 }, (_, index) => String(index)), new Map(), 50);
    expect(virtualRange(layout, 1_000, 500, 100)).toEqual({ start: 17, end: 33 });
    expect(virtualRange(buildVirtualLayout([], new Map(), 50), 0, 500)).toEqual({ start: 0, end: 0 });
  });
});
