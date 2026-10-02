import { describe, expect, it, vi } from "vitest";
import { syncUnreadAppBadge, totalUnreadCount } from "./app-badge";

describe("app badge", () => {
  it("sums only positive finite integer unread counts", () => {
    expect(totalUnreadCount({ a: 2, b: 1.9, c: -4, d: Number.NaN })).toBe(3);
  });

  it("sets an exact badge from the local unread projection", async () => {
    const setAppBadge = vi.fn(async () => undefined);
    await syncUnreadAppBadge({ a: 2, b: 3 }, { setAppBadge });
    expect(setAppBadge).toHaveBeenCalledWith(5);
  });

  it("clears the badge without failing on unsupported or rejected APIs", async () => {
    const clearAppBadge = vi.fn(async () => undefined);
    await syncUnreadAppBadge({}, { clearAppBadge });
    expect(clearAppBadge).toHaveBeenCalledOnce();
    await expect(syncUnreadAppBadge({ a: 1 }, { setAppBadge: async () => { throw new Error("denied"); } })).resolves.toBeUndefined();
    await expect(syncUnreadAppBadge({}, {})).resolves.toBeUndefined();
  });
});
