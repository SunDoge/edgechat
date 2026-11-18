import { afterEach, expect, it, vi } from "vitest";
import { checkForPwaUpdate, dismissPwaUpdate, subscribePwaUpdates } from "./pwa-lifecycle";

afterEach(() => {
  dismissPwaUpdate();
  vi.unstubAllGlobals();
});

it("checks the active worker for a newer version", async () => {
  const update = vi.fn();
  vi.stubGlobal("navigator", {
    serviceWorker: { controller: {}, getRegistration: async () => ({ active: {}, update }) },
  });
  await expect(checkForPwaUpdate()).resolves.toBe("current");
  expect(update).toHaveBeenCalledOnce();
});

it("offers an already downloaded update without activating it", async () => {
  const update = vi.fn();
  const postMessage = vi.fn();
  vi.stubGlobal("navigator", {
    serviceWorker: { controller: {}, getRegistration: async () => ({ active: {}, waiting: { postMessage }, update }) },
  });
  const listener = vi.fn();
  const unsubscribe = subscribePwaUpdates(listener);
  try {
    await expect(checkForPwaUpdate()).resolves.toBe("ready");
    expect(listener).toHaveBeenLastCalledWith("ready");
    expect(update).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});
