import { describe, expect, it, vi } from "vitest";
import { acquireTabLease, awaitTabHandoff, DEVICE_STATE_LOCK, persistBeforeTabHandoff, TAB_HANDOFF_DENIED_EVENT, TAB_HANDOFF_READY_EVENT, type LockProvider } from "./tab-coordination";

describe("single active tab coordination", () => {
  it("holds the exclusive device-state lock until the lease is released", async () => {
    let callbackFinished = false;
    const provider: LockProvider = {
      async request(name, options, callback) {
        expect(name).toBe(DEVICE_STATE_LOCK);
        expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
        await callback({ name });
        callbackFinished = true;
      },
    };
    const lease = await acquireTabLease(provider, false);
    expect(lease).not.toBeNull();
    expect(callbackFinished).toBe(false);
    lease!.release(); lease!.release();
    await Promise.resolve(); await Promise.resolve();
    expect(callbackFinished).toBe(true);
  });

  it("returns null without starting the app when another tab owns the lock", async () => {
    const provider: LockProvider = { async request(_name, options, callback) { expect(options.ifAvailable).toBe(true); await callback(null); } };
    await expect(acquireTabLease(provider, false)).resolves.toBeNull();
  });

  it("waits for draft persistence and distinguishes denied handoff", async () => {
    vi.useFakeTimers();
    const ready = awaitTabHandoff();
    window.dispatchEvent(new Event(TAB_HANDOFF_READY_EVENT));
    await expect(ready).resolves.toBe("ready");
    const denied = awaitTabHandoff();
    window.dispatchEvent(new Event(TAB_HANDOFF_DENIED_EVENT));
    await expect(denied).resolves.toBe("denied");
    vi.useRealTimers();
  });

  it("allows handoff only after local draft persistence succeeds", async () => {
    let finish!: () => void;
    const persistence = new Promise<void>((resolve) => { finish = resolve; });
    const handoff = persistBeforeTabHandoff(() => persistence);
    let settled = false;
    void handoff.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(handoff).resolves.toBe("ready");

    await expect(persistBeforeTabHandoff(async () => { throw new Error("local database unavailable"); })).resolves.toBe("denied");
  });
});
