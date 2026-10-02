import { describe, expect, it, vi } from "vitest";
import { inspectLocalStorageHealth, localStorageRatio, requestPersistentLocalStorage, type StorageManagerLike } from "./local-storage-health";

describe("local browser storage health", () => {
  it("reports approximate origin usage separately from persistence", async () => {
    const storage: StorageManagerLike = {
      estimate: vi.fn(async () => ({ usage: 125.9, quota: 1_000.8 })),
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => false),
    };
    const health = await inspectLocalStorageHealth(storage);
    expect(health).toEqual({ persistence: "best-effort", canRequestPersistence: true, usage: 125, quota: 1_000 });
    expect(localStorageRatio(health)).toBe(0.125);
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("requests persistence only from the explicit action and keeps refreshed estimates", async () => {
    const calls: string[] = [];
    const storage: StorageManagerLike = {
      persist: vi.fn(async () => { calls.push("persist"); return true; }),
      persisted: vi.fn(async () => { calls.push("persisted"); return true; }),
      estimate: vi.fn(async () => { calls.push("estimate"); return { usage: 400, quota: 2_000 }; }),
    };
    const result = await requestPersistentLocalStorage(storage);
    expect(calls[0]).toBe("persist");
    expect(result).toEqual({ outcome: "granted", health: { persistence: "persistent", canRequestPersistence: false, usage: 400, quota: 2_000 } });
  });

  it("handles denial, missing APIs and browser exceptions without claiming durability", async () => {
    const denied = await requestPersistentLocalStorage({ persist: async () => false, persisted: async () => false, estimate: async () => ({}) });
    expect(denied.outcome).toBe("denied"); expect(denied.health.persistence).toBe("best-effort");
    expect(await inspectLocalStorageHealth(undefined)).toEqual({ persistence: "unsupported", canRequestPersistence: false, usage: null, quota: null });
    const failed = await requestPersistentLocalStorage({ persist: async () => { throw new TypeError("disabled"); }, persisted: async () => { throw new TypeError("disabled"); } });
    expect(failed.outcome).toBe("error"); expect(failed.health.persistence).toBe("unknown");
  });

  it("does not produce misleading ratios for absent or zero quota", () => {
    expect(localStorageRatio({ persistence: "unknown", canRequestPersistence: false, usage: 10, quota: 0 })).toBeNull();
    expect(localStorageRatio({ persistence: "unsupported", canRequestPersistence: false, usage: null, quota: null })).toBeNull();
  });
});
