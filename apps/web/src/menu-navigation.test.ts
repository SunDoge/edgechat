import { describe, expect, it, vi } from "vitest";
import { handleMenuNavigation, openMenuFromTrigger } from "./menu-navigation";

function keyEvent(key: string) {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("accessible menu keyboard navigation", () => {
  it("wraps arrow navigation and supports Home/End", () => {
    const focus = [vi.fn(), vi.fn(), vi.fn()];
    const items = focus.map((callback) => ({ focus: callback }));
    expect(handleMenuNavigation(keyEvent("ArrowDown"), items, 2, vi.fn())).toBe(true);
    expect(focus[0]).toHaveBeenCalledOnce();
    expect(handleMenuNavigation(keyEvent("ArrowUp"), items, 0, vi.fn())).toBe(true);
    expect(focus[2]).toHaveBeenCalledOnce();
    handleMenuNavigation(keyEvent("Home"), items, 2, vi.fn());
    handleMenuNavigation(keyEvent("End"), items, 0, vi.fn());
    expect(focus[0]).toHaveBeenCalledTimes(2);
    expect(focus[2]).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape, while Tab keeps the native focus order", () => {
    const close = vi.fn(); const escape = keyEvent("Escape"); const tab = keyEvent("Tab");
    expect(handleMenuNavigation(escape, [], -1, close)).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(handleMenuNavigation(tab, [], -1, close)).toBe(false);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("opens a trigger menu at the correct edge", () => {
    const open = vi.fn();
    expect(openMenuFromTrigger(keyEvent("ArrowDown"), open)).toBe(true);
    expect(open).toHaveBeenLastCalledWith(false);
    expect(openMenuFromTrigger(keyEvent("ArrowUp"), open)).toBe(true);
    expect(open).toHaveBeenLastCalledWith(true);
    expect(openMenuFromTrigger(keyEvent("Enter"), open)).toBe(false);
  });
});
